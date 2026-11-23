import SwiftUI

@main
struct AirCamApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .onAppear { UIApplication.shared.isIdleTimerDisabled = true } // the phone is a webcam: never auto-lock
        }
        .onChange(of: phase) { p in
            if p == .active { model.camera.start() }
        }
    }
}
