// Runs a product's Node CLI (`node <script.mjs> <args>`) from the menu-bar app. Every app action goes
// through the CLI, so this is the app's only bridge to it.
//
// API
//   findNode() -> String?          node at /opt/homebrew/bin, /usr/local/bin, /usr/bin (first executable).
//   CLIConfig(scriptEnvVar:scriptCandidates:pathEnv:)
//       scriptEnvVar               Env var naming the script, used as-is when set (e.g. a dev checkout).
//       scriptCandidates           Absolute paths tried in order after it; the first that exists wins
//                                  (typically the default checkout, then the copy in Contents/Resources).
//       pathEnv                    PATH given to the CLI (default CLIConfig.defaultPATH, Homebrew first).
//     .findScript() -> String?
//     .environment(extra) -> [String: String]   this process's env + PATH + extra.
//   CLIRunner(config)
//     .resolve() -> (node, script)?            nil when either is missing.
//     .capture(args, input:, done:)            Async. stdout only (stderr dropped), optional stdin text.
//                                              done(status, stdout) on main. Does nothing (no callback)
//                                              when node or the script is missing.
//     .background(args, done:) -> Bool        Async. stdout+stderr merged; done(status, lastLine) on main.
//                                              Returns false (and never calls done) when node or the
//                                              script is missing, so the caller can say so.
//     .progress(args, extraEnv:, onProgress:, onLine:, done:) -> Error?
//                                              Streams stdout+stderr line by line: `PROGRESS:<pct>:<title>`
//                                              lines go to onProgress (on main), every other non-blank line
//                                              to onLine (on the reader thread). done(status) on main.
//                                              Returns nil once started, else the launch error
//                                              (CLIRunnerError.notFound when node/script is missing).
//   streamOutput(of:pipe:onText:done:)   Streams a not-yet-started Process's output pipe as UTF-8 text
//                                        (in order, on a private serial queue; a multi-byte character is
//                                        never split) and calls done(status) on main once the process has
//                                        exited AND everything it wrote has been delivered. Call it before
//                                        process.run(). Used by .progress and the apps' run-log windows.
//   lastJSON(text) -> Any?             The last output line that parses as JSON (CLIs print progress first).
//   parseProgress(line) -> (pct, title)?   Parses `PROGRESS:<pct>:<title>`.
import Foundation

func findNode() -> String? {
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if FileManager.default.isExecutableFile(atPath: p) { return p }
    }
    return nil
}

struct CLIConfig {
    static let defaultPATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    let scriptEnvVar: String
    let scriptCandidates: [String]
    var pathEnv: String = CLIConfig.defaultPATH

    func findScript() -> String? {
        if let env = ProcessInfo.processInfo.environment[scriptEnvVar] { return env }
        return scriptCandidates.first { FileManager.default.fileExists(atPath: $0) }
    }

    func environment(_ extra: [String: String] = [:]) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = pathEnv
        for (k, v) in extra { env[k] = v }
        return env
    }
}

enum CLIRunnerError: Error, LocalizedError {
    case notFound
    var errorDescription: String? { "Can't find node or the CLI script." }
}

/// The last line of `text` that parses as JSON: the CLI may print progress lines first.
func lastJSON(_ text: String) -> Any? {
    for line in text.split(separator: "\n").reversed() {
        if let d = String(line).data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) { return o }
    }
    return nil
}

/// `PROGRESS:<pct>:<title>` -> (pct, title); nil for any other line.
func parseProgress(_ line: String) -> (pct: Double, title: String)? {
    guard line.hasPrefix("PROGRESS:") else { return nil }
    let parts = line.dropFirst(9).split(separator: ":", maxSplits: 1).map(String.init)
    guard parts.count == 2, let pct = Double(parts[0]) else { return nil }
    return (pct, parts[1])
}

struct CLIRunner {
    let config: CLIConfig

    func resolve() -> (node: String, script: String)? {
        guard let node = findNode(), let script = config.findScript() else { return nil }
        return (node, script)
    }

    /// Runs the CLI and hands back everything it printed on stdout.
    func capture(_ args: [String], input: String? = nil, done: @escaping (Int32, String) -> Void) {
        guard let (node, script) = resolve() else { return }
        let env = config.environment()
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [script] + args
            let pipe = Pipe()
            p.standardOutput = pipe; p.standardError = Pipe()
            let inPipe = Pipe()
            p.standardInput = inPipe
            p.environment = env
            do { try p.run() } catch { DispatchQueue.main.async { done(1, "") }; return }
            if let input { inPipe.fileHandleForWriting.write(Data(input.utf8)) }
            try? inPipe.fileHandleForWriting.close()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            DispatchQueue.main.async { done(p.terminationStatus, String(data: data, encoding: .utf8) ?? "") }
        }
    }

    /// Runs the CLI in the background and reports the last line it printed (stdout or stderr).
    @discardableResult
    func background(_ args: [String], done: @escaping (Int32, String) -> Void) -> Bool {
        guard let (node, script) = resolve() else { return false }
        let env = config.environment()
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [script] + args
            let pipe = Pipe()
            p.standardOutput = pipe; p.standardError = pipe
            p.environment = env
            do { try p.run() } catch { DispatchQueue.main.async { done(1, error.localizedDescription) }; return }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            let text = String(data: data, encoding: .utf8) ?? ""
            let last = text.split(separator: "\n").last.map(String.init) ?? ""
            DispatchQueue.main.async { done(p.terminationStatus, last) }
        }
        return true
    }

    /// Runs a long CLI job (`… --progress`) and streams its PROGRESS lines.
    @discardableResult
    func progress(_ args: [String], extraEnv: [String: String] = [:],
                  onProgress: @escaping (Double, String) -> Void,
                  onLine: ((String) -> Void)? = nil,
                  done: @escaping (Int32) -> Void) -> Error? {
        guard let (node, script) = resolve() else { return CLIRunnerError.notFound }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script] + args
        p.environment = config.environment(extraEnv)
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe
        var buffer = ""
        func emit(_ line: String) {
            if line.hasPrefix("PROGRESS:") {
                if let (pct, title) = parseProgress(line) {
                    DispatchQueue.main.async { onProgress(pct, title) }
                }
            } else if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                onLine?(line)
            }
        }
        streamOutput(of: p, pipe: pipe, onText: { chunk in
            buffer += chunk
            while let nl = buffer.firstIndex(of: "\n") {
                emit(String(buffer[buffer.startIndex..<nl]))
                buffer = String(buffer[buffer.index(after: nl)...])
            }
        }, onEnd: {
            // The CLI's last line (often `Error: …`) may not end in a newline.
            if !buffer.isEmpty { emit(buffer); buffer = "" }
        }, done: done)
        do { try p.run() } catch { pipe.fileHandleForReading.readabilityHandler = nil; return error }
        return nil
    }
}

/// Streams `process`'s output `pipe` (already set as its stdout/stderr, not yet run) as text.
///
/// Why not just readabilityHandler + terminationHandler: the termination handler can run before the
/// reader has drained the pipe, so clearing the handler there drops the process's last output (the
/// `Error: …` line a CLI prints just before exiting). Here every read happens on one serial queue and,
/// once the process has exited, that queue reads whatever is still in the pipe before `done`. The pipe's
/// read end is non-blocking, so that final drain can't hang on a detached grandchild (an emulator, a VM)
/// that inherited the write end and keeps it open: everything the process itself wrote is already in
/// the pipe when it exits, and later writes by such a child are not its output.
///
/// onText and onEnd run on the private queue (in order, never after onEnd); done(status) runs on main.
func streamOutput(of process: Process, pipe: Pipe,
                  onText: @escaping (String) -> Void,
                  onEnd: @escaping () -> Void = {},
                  done: @escaping (Int32) -> Void) {
    let queue = DispatchQueue(label: "CLIRunner.streamOutput")
    let handle = pipe.fileHandleForReading
    let fd = handle.fileDescriptor
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    var pending = Data()      // bytes of a UTF-8 character split across reads
    var ended = false
    // Reads everything currently in the pipe. Returns false at EOF.
    func drain() -> Bool {
        var buf = [UInt8](repeating: 0, count: 65536)
        while !ended {
            let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n > 0 {
                pending.append(contentsOf: buf[0..<n])
                deliver(final: false)
            } else if n == 0 {
                return false
            } else if errno == EINTR {
                continue
            } else {
                return true   // EAGAIN: nothing more for now
            }
        }
        return false
    }
    func deliver(final: Bool) {
        guard !pending.isEmpty else { return }
        // Hold back an incomplete trailing UTF-8 sequence (at most 3 bytes) until the rest arrives.
        var cut = pending.count
        if !final {
            for back in 1...min(3, pending.count) {
                let b = pending[pending.count - back]
                if b & 0xC0 == 0x80 { continue }            // continuation byte: keep looking back
                if b & 0xC0 == 0xC0 {                        // lead byte: complete only if enough follow
                    let need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : 2
                    if back < need { cut = pending.count - back }
                }
                break
            }
        }
        let text = String(decoding: pending.prefix(cut), as: UTF8.self)
        pending = Data(pending.suffix(from: pending.startIndex + cut))
        if !text.isEmpty { onText(text) }
    }
    handle.readabilityHandler = { h in
        queue.sync {
            if !drain() { h.readabilityHandler = nil }   // EOF: stop the source from firing again
        }
    }
    process.terminationHandler = { proc in
        queue.async {
            handle.readabilityHandler = nil
            _ = drain()
            deliver(final: true)
            ended = true
            onEnd()
            DispatchQueue.main.async { done(proc.terminationStatus) }
        }
    }
}
