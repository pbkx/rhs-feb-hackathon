const { spawn } = require("node:child_process")

function run(command, args) {
  return spawn(command, args, {
    stdio: "inherit",
  })
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
const processes = [run(npmCommand, ["run", "dev:frontend"]), run(npmCommand, ["run", "dev:server"])]

let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of processes) {
    if (!child.killed) {
      child.kill("SIGTERM")
    }
  }
  setTimeout(() => process.exit(code), 100)
}

for (const child of processes) {
  child.on("exit", (code) => {
    if (shuttingDown) return
    shutdown(code ?? 0)
  })
  child.on("error", () => {
    shutdown(1)
  })
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))
