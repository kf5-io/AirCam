import Network
import UIKit

// TCP server on port 47800, advertised over Bonjour. One PC at a time (a new one replaces the old).
// Over USB the PC reaches the same port through usbmux (Apple Devices service).
final class Server {
    let queue = DispatchQueue(label: "aircam.net")
    private let onQueueKey = DispatchSpecificKey<Bool>()
    private var listener: NWListener?
    private var conn: NWConnection?
    private var pending = 0 // bytes queued but not yet handed to the OS
    var onConnection: ((String?) -> Void)? // peer description, nil when disconnected
    var onMessage: ((Msg, Data) -> Void)?

    init() { queue.setSpecific(key: onQueueKey, value: true) }

    /// queue.sync that is safe to call from the network queue itself (message handlers run there).
    private func onQueue<T>(_ f: () -> T) -> T { DispatchQueue.getSpecific(key: onQueueKey) == true ? f() : queue.sync(execute: f) }

    var isConnected: Bool { onQueue { conn != nil } }

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
        pending = 0
        c.stateUpdateHandler = { [weak self, weak c] state in
            guard let self, let c, self.conn === c else { return }
            switch state {
            case .ready: self.onConnection?(Self.describe(c.endpoint))
            case .failed, .cancelled: self.conn = nil; self.onConnection?(nil)
            default: break
            }
        }
        c.start(queue: queue)
        receive(c)
    }

    private static func describe(_ e: NWEndpoint) -> String {
        if case let .hostPort(host, _) = e {
            let h = "\(host)"
            return h.hasPrefix("127.") || h == "::1" ? "USB" : h
        }
        return "\(e)"
    }

    private func receive(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 5, maximumLength: 5) { [weak self] header, _, _, err in
            guard let self, err == nil, let header, header.count == 5 else { c.cancel(); return }
            let b = [UInt8](header)
            let len = Int(b[1]) << 24 | Int(b[2]) << 16 | Int(b[3]) << 8 | Int(b[4])
            guard len <= 16 << 20 else { c.cancel(); return } // 16 MB cap (background images)
            let type = Msg(rawValue: b[0])
            if len == 0 { if let type { self.onMessage?(type, Data()) }; self.receive(c); return }
            c.receive(minimumIncompleteLength: len, maximumLength: len) { body, _, _, err in
                guard err == nil, let body, body.count == len else { c.cancel(); return }
                if let type { self.onMessage?(type, body) }
                self.receive(c)
            }
        }
    }

    /// Sends a message. Returns false (and drops it) when `droppable` and the link is backed up.
    @discardableResult
    func send(_ type: Msg, _ payload: Data, droppable: Bool = false) -> Bool {
        onQueue {
            guard let c = conn else { return false }
            if droppable && pending > 1_500_000 { return false } // Wi-Fi congested: drop rather than add latency
            let d = frame(type, payload)
            pending += d.count
            c.send(content: d, completion: .contentProcessed { [weak self] _ in
                self?.queue.async { self?.pending -= d.count }
            })
            return true
        }
    }
}
