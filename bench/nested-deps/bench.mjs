import { execSync, spawn } from 'child_process'
import { join } from 'path'
import { fileURLToPath } from 'url'
import fetch from 'node-fetch'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  promises as fs,
} from 'fs'
import treeKill from 'tree-kill'

const ROOT_DIR = join(fileURLToPath(import.meta.url), '..', '..', '..')

async function killApp(instance) {
  await new Promise((resolve, reject) => {
    treeKill(instance.pid, (err) => {
      if (err) {
        if (
          process.platform === 'win32' &&
          typeof err.message === 'string' &&
          (err.message.includes(`no running instance of the task`) ||
            err.message.includes(`not found`))
        ) {
          // Windows throws an error if the process is already stopped
          //
          // Command failed: taskkill /pid 6924 /T /F
          // ERROR: The process with PID 6924 (child process of PID 6736) could not be terminated.
          // Reason: There is no running instance of the task.
          return resolve()
        }
        return reject(err)
      }

      resolve()
    })
  })
}

class File {
  constructor(path) {
    this.path = path
    this.originalContent = existsSync(this.path)
      ? readFileSync(this.path, 'utf8')
      : null
  }

  write(content) {
    if (!this.originalContent) {
      this.originalContent = content
    }
    writeFileSync(this.path, content, 'utf8')
  }

  replace(pattern, newValue) {
    const currentContent = readFileSync(this.path, 'utf8')
    if (pattern instanceof RegExp) {
      if (!pattern.test(currentContent)) {
        throw new Error(
          `Failed to replace content.\n\nPattern: ${pattern.toString()}\n\nContent: ${currentContent}`
        )
      }
    } else if (typeof pattern === 'string') {
      if (!currentContent.includes(pattern)) {
        throw new Error(
          `Failed to replace content.\n\nPattern: ${pattern}\n\nContent: ${currentContent}`
        )
      }
    } else {
      throw new Error(`Unknown replacement attempt type: ${pattern}`)
    }

    const newContent = currentContent.replace(pattern, newValue)
    this.write(newContent)
  }

  prepend(line) {
    const currentContent = readFileSync(this.path, 'utf8')
    this.write(line + '\n' + currentContent)
  }

  delete() {
    unlinkSync(this.path)
  }

  restore() {
    this.write(this.originalContent)
  }
}

function runNextCommandDev(argv, opts = {}) {
  const cwd = process.cwd()
  const nextBin = join(
    ROOT_DIR,
    'node_modules',
    '.bin',
    `next${process.platform === 'win32' ? '.cmd' : ''}`
  )
  const env = {
    ...process.env,
    NODE_ENV: undefined,
    __NEXT_TEST_MODE: 'true',
    FORCE_COLOR: 3,
    ...opts.env,
  }

  const nodeArgs = opts.nodeArgs || []
  return new Promise((resolve, reject) => {
    const instance = spawn(nextBin, [...nodeArgs, ...argv], {
      cwd,
      env,
    })
    let didResolve = false

    function handleStdout(data) {
      const message = data.toString()
      const bootupMarkers = {
        dev: /compiled .*successfully/i,
        start: /started server/i,
      }
      if (
        (opts.bootupMarker && opts.bootupMarker.test(message)) ||
        bootupMarkers[opts.nextStart ? 'start' : 'dev'].test(message)
      ) {
        if (!didResolve) {
          didResolve = true
          resolve(instance)
          instance.removeListener('data', handleStdout)
        }
      }

      if (typeof opts.onStdout === 'function') {
        opts.onStdout(message)
      }

      if (opts.stdout !== false) {
        process.stdout.write(message)
      }
    }

    function handleStderr(data) {
      const message = data.toString()
      if (typeof opts.onStderr === 'function') {
        opts.onStderr(message)
      }

      if (opts.stderr !== false) {
        process.stderr.write(message)
      }
    }

    instance.stdout.on('data', handleStdout)
    instance.stderr.on('data', handleStderr)

    instance.on('close', () => {
      instance.stdout.removeListener('data', handleStdout)
      instance.stderr.removeListener('data', handleStderr)
      if (!didResolve) {
        didResolve = true
        resolve()
      }
    })

    instance.on('error', (err) => {
      reject(err)
    })
  })
}

function waitFor(millis) {
  return new Promise((resolve) => setTimeout(resolve, millis))
}

await fs.rm('.next', { recursive: true }).catch(() => {})
const file = new File('pages/index.jsx')
const results = []

try {
  const instance = await runNextCommandDev(['dev', '--port', '3000'])

  function waitForCompiled() {
    return new Promise((resolve) => {
      function waitForOnData(data) {
        const message = data.toString()
        const compiledRegex =
          /compiled client and server successfully in (\d*[.]?\d+)\s*(m?s) \((\d+) modules\)/gm
        const matched = compiledRegex.exec(message)
        if (matched) {
          resolve({
            'time (ms)': (matched[2] === 's' ? 1000 : 1) * Number(matched[1]),
            modules: Number(matched[3]),
          })
          instance.stdout.removeListener('data', waitForOnData)
        }
      }
      instance.stdout.on('data', waitForOnData)
    })
  }

  const [res, initial] = await Promise.all([
    fetch('http://localhost:3000/'),
    waitForCompiled(),
  ])
  if (res.status !== 200) {
    throw new Error('Fetching / failed')
  }

  results.push(initial)

  file.prepend('// First edit')

  results.push(await waitForCompiled())

  await waitFor(1000)

  file.prepend('// Second edit')

  results.push(await waitForCompiled())

  await waitFor(1000)

  file.prepend('// Third edit')

  results.push(await waitForCompiled())

  console.table(results)

  await killApp(instance)
  await fs.rm('.next', { recursive: true })

  execSync('yarn clean-trace-jaeger', {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  })
  const traceString = await fs.readFile('./.next/trace', 'utf8')
  const traces = traceString
    .split('\n')
    .filter((line) => line)
    .map((line) => JSON.parse(line))
  const { duration } = traces.pop().find(({ name }) => name === 'next-build')
  console.log(duration)
} finally {
  file.restore()
}
