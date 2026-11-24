import Network
import UIKit

// TCP server on port 47800, advertised over Bonjour. One PC at a time (a new one replaces the old).
// Over USB the PC reaches the same port through usbmux (Apple Devices service).
// Everything after the handshake is encrypted (Secure.swift); each record carries one protocol message.
final class Server {
    let queue = DispatchQueue(label: "aircam.net")
    private let onQueueKey = DispatchSpecificKey<Bool>()
    private var listener: NWListener?
    private var conn: NWConnection?
    private var sec: SecureSession? // set once the handshake with `conn` is done
    private var pending = 0 // bytes queued but not yet handed to the OS
    var onConnection: ((String?) -> Void)? // peer description, nil when disconnected
    var onMessage: ((Msg, Data) -> Void)?

    init() { queue.setSpecific(key: onQueueKey, value: true) }

    /// queue.sync that is safe to call from the network queue itself (message handlers run there).
    private func onQueue<T>(_ f: () -> T) -> T { DispatchQueue.getSpecific(key: onQueueKey) == true ? f() : queue.sync(execute: f) }

    var isConnected: Bool { onQueue { conn != nil && sec != nil } }
    /// Link backed up (bytes queued but not yet handed to the OS).
    var isCongested: Bool { onQueue { pending > 300_000 } }

    func start() {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        guard let l = try? NWListener(using: params, on: NWEndpoint.Port(rawValue: aircamPort)!) else { return }
        l.service = NWListener.Service(name: UIDevice.current.name, type: aircamBonjourType)
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.stateUpdateHandler = { [weak self] state in
            if case .failed = state { // e.g. network change: restart after a moment
                self?.listener?.cancel()
                self?.queue.asyncAfter(deadline: .now() + 1) { self?.start() }
            }
        }
        l.start(queue: queue)
        listener = l
    }

    private func accept(_ c: NWConnection) {
        conn?.cancel()
        conn = c
        sec = nil
        pending = 0
        c.stateUpdateHandler = { [weak self, weak c] state in
            guard let self, let c, self.conn === c else { return }
            switch state {
            case .failed, .cancelled: self.conn = nil; self.sec = nil; self.onConnection?(nil)
            default: break
            }
        }
        c.start(queue: queue)
        handshake(c)
    }

    // PC sends its hello first; we answer with ours and derive the keys.
    private func handshake(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: SecureSession.helloLength, maximumLength: SecureSession.helloLength) { [weak self] data, _, _, err in
            guard let self, err == nil, let data, self.conn === c else { c.cancel(); return }
            let s = SecureSession()
            do { try s.accept(data) } catch { c.cancel(); return }
            c.send(content: s.hello, completion: .contentProcessed { _ in })
            self.sec = s
            self.onConnection?(Self.describe(c.endpoint))
            self.receive(c, s)
        }
    }

    private static func describe(_ e: NWEndpoint) -> String {
        if case let .hostPort(host, _) = e {
            let h = "\(host)"
            return h.hasPrefix("127.") || h == "::1" ? "USB" : h
        }
        return "\(e)"
    }

    // Records: [u32 BE length][sealed message]; the plaintext is one [type][u32 length][payload] message.
    private func receive(_ c: NWConnection, _ s: SecureSession) {
        c.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] header, _, _, err in
            guard let self, err == nil, let header, header.count == 4 else { c.cancel(); return }
            let b = [UInt8](header)
            let len = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
            guard len >= 16 + 5, len <= 17 << 20 else { c.cancel(); return } // 16 MB payload cap (background images)
            c.receive(minimumIncompleteLength: len, maximumLength: len) { body, _, _, err in
                guard err == nil, let body, body.count == len, let plain = try? s.open(body), plain.count >= 5 else { c.cancel(); return }
                let p = [UInt8](plain)
                let n = Int(p[1]) << 24 | Int(p[2]) << 16 | Int(p[3]) << 8 | Int(p[4])
                guard n == p.count - 5 else { c.cancel(); return }
                if let type = Msg(rawValue: p[0]) { self.onMessage?(type, Data(p[5...])) }
                self.receive(c, s)
            }
        }
    }

    /// Sends a message. Returns false (and drops it) when `droppable` and the link is backed up.
    @discardableResult
    func send(_ type: Msg, _ payload: Data, droppable: Bool = false) -> Bool {
        onQueue {
            guard let c = conn, let s = sec else { return false }
            if droppable && pending > 1_500_000 { return false } // Wi-Fi congested: drop rather than add latency
            guard let d = try? s.seal(frame(type, payload)) else { return false }
            pending += d.count
            c.send(content: d, completion: .contentProcessed { [weak self] _ in
                self?.queue.async { self?.pending -= d.count }
            })
            return true
        }
    }
}
