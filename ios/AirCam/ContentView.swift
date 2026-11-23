import AVFoundation
import SwiftUI

private let accent = Color(red: 0x7c / 255, green: 0x5c / 255, blue: 1)
private let accent2 = Color(red: 0xb3 / 255, green: 0x9d / 255, blue: 1)

struct ContentView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ZStack {
            Color(red: 7 / 255, green: 7 / 255, blue: 10 / 255).ignoresSafeArea()
            if model.dimmed {
                // Black screen saves battery and heat; tap anywhere to wake.
                Color.black.ignoresSafeArea().onTapGesture { model.dimmed = false; UIScreen.main.brightness = 0.6 }
            } else {
                content
            }
        }
        .statusBarHidden(model.dimmed)
        .preferredColorScheme(.dark)
    }

    private var content: some View {
        VStack(spacing: 20) {
            HStack(spacing: 10) {
                Image(systemName: "dot.radiowaves.up.forward").foregroundStyle(accent2)
                Text("AirCam").font(.system(size: 22, weight: .bold))
                Spacer()
                Circle().fill(model.peer == nil ? Color.orange : Color.green).frame(width: 9, height: 9)
                Text(model.peer == nil ? "En attente" : "En direct").font(.subheadline).foregroundStyle(.secondary)
            }
            CameraPreview(session: model.camera.session)
                .aspectRatio(16 / 9, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.09)))
            card
            Spacer(minLength: 0)
            Button {
                model.dimmed = true
                UIScreen.main.brightness = 0.01
            } label: {
                Label("Écran noir", systemImage: "moon.fill").frame(maxWidth: .infinity).frame(height: 46)
            }
            .buttonStyle(.plain)
            .background(Color.white.opacity(0.11), in: RoundedRectangle(cornerRadius: 12))
            .disabled(model.peer == nil)
            .opacity(model.peer == nil ? 0.4 : 1)
        }
        .padding(20)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let peer = model.peer {
                Text("Connecté \(peer == "USB" ? "en USB" : "à \(peer)")").font(.headline)
                Text("\(model.settings.resolution) · \(model.settings.fps) i/s · caméra \(label(model.settings.camera))")
                    .foregroundStyle(.secondary)
                Text("Tous les réglages se font depuis AirCam sur le PC.").font(.footnote).foregroundStyle(.secondary)
            } else {
                Text("Ouvre AirCam sur ton PC").font(.headline)
                Text("Même réseau Wi-Fi, ou branche l'iPhone en USB. Le PC trouve l'iPhone tout seul.")
                    .foregroundStyle(.secondary)
                Text("Garde l'app ouverte : iOS coupe la caméra quand elle passe en arrière-plan.")
                    .font(.footnote).foregroundStyle(accent2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }

    private func label(_ cam: String) -> String {
        ["front": "avant", "back": "arrière", "ultrawide": "ultra grand-angle", "tele": "téléobjectif"][cam] ?? cam
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.preview.session = session
        v.preview.videoGravity = .resizeAspectFill
        v.backgroundColor = .black
        return v
    }
    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
