import AppKit
import Foundation
import Darwin

// A real application identity lets macOS ask for Desktop access only. This
// helper never changes privacy settings, reads keys or accepts command paths.
final class BackupDelegate: NSObject, NSApplicationDelegate {
    private var child: Process?

    private func fail(_ status: Int32) {
        FileHandle.standardError.write(Data("Q backup launcher failed; check Desktop permission or backup dependencies.\n".utf8))
        Darwin.exit(status)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.count == 1 else { fail(64); return }
        let destination = URL(fileURLWithPath: "/Users/kai/Desktop/异地备份", isDirectory: true)
        let support = "/Users/kai/Library/Application Support/Q/offsite-backup"
        do {
            let manager = FileManager.default
            // Access the specific destination through this app before starting
            // Python. macOS owns the prompt; denial is a failed backup run.
            try manager.createDirectory(at: destination, withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
            let properties = try destination.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
            guard properties.isSymbolicLink != true, properties.isDirectory == true else { fail(73); return }
            _ = try manager.contentsOfDirectory(at: destination, includingPropertiesForKeys: nil)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            process.arguments = [support + "/pull.py", "--destination", destination.path,
                                 "--identity", "/Users/kai/.ssh/id_ed25519_gitlab_kai",
                                 "--recipient", "/Users/kai/.ssh/id_ed25519_gitlab_kai.pub",
                                 "--age", support + "/age"]
            // No inherited interpreter/plugin injection or shell evaluation.
            process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/Users/kai",
                                   "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"]
            process.standardOutput = FileHandle.standardOutput
            process.standardError = FileHandle.standardError
            process.terminationHandler = { finished in
                let status: Int32 = finished.terminationReason == .exit ? finished.terminationStatus : 1
                DispatchQueue.main.async { Darwin.exit(status) }
            }
            child = process
            try process.run()
        } catch {
            fail(1)
        }
    }
}

let application = NSApplication.shared
let delegate = BackupDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
