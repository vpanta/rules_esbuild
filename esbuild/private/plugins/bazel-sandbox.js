const path = require('path')
const process = require('process')

// Regex matching any non-relative import path
const pkgImport = /^[^.]/

const bindir = process.env.BAZEL_BINDIR
const execroot = process.env.JS_BINARY__EXECROOT

// Under Bazel, esbuild will follow symlinks out of the sandbox when the sandbox is enabled. See https://github.com/aspect-build/rules_esbuild/issues/58.
// This plugin using a separate resolver to detect if the the resolution has left the execroot (which is the root of the sandbox
// when sandboxing is enabled) and patches the resolution back into the sandbox.
function bazelSandboxPlugin() {
  return {
    name: 'bazel-sandbox',
    setup(build) {
      const moduleCache = new Map()
      build.onResolve(
        { filter: /./ },
        async ({ path: importPath, ...otherOptions }) => {
          // NB: these lines are to prevent infinite recursion when we call `build.resolve`.
          if (otherOptions.pluginData) {
            if (otherOptions.pluginData.executedSandboxPlugin) {
              return
            }
          } else {
            otherOptions.pluginData = {}
          }
          otherOptions.pluginData.executedSandboxPlugin = true

          // Prevent us from loading different forms of a module (CJS vs ESM).
          if (pkgImport.test(importPath)) {
            if (!moduleCache.has(importPath)) {
              moduleCache.set(
                importPath,
                resolveInExecroot(build, importPath, otherOptions)
              )
            }
            return await moduleCache.get(importPath)
          }
          return await resolveInExecroot(build, importPath, otherOptions)
        }
      )
    },
  }
}

async function resolveInExecroot(build, importPath, otherOptions) {
  const result = await build.resolve(importPath, otherOptions)

  if (result.errors && result.errors.length) {
    // There was an error resolving, just return the error as-is.
    return result
  }

  // If esbuild attempts to leave the execroot, map the path back into the execroot.
  if (!result.path.startsWith(execroot)) {
    // If it tried to leave bazel-bin, error out completely.
    if (!result.path.includes(bindir)) {
      throw new Error(
        `Error: esbuild resolved a path outside of BAZEL_BINDIR (${bindir}): ${result.path}`
      )
    }
    // Otherwise remap the bindir-relative path
    const correctedPath = path.join(
      execroot,
      result.path.substring(result.path.indexOf(bindir))
    )
    if (!!process.env.JS_BINARY__LOG_DEBUG) {
      console.error(
        `DEBUG: [bazel-sandbox] correcting esbuild resolution ${result.path} that left the sandbox to ${correctedPath}.`
      )
    }
    result.path = correctedPath
  }
  return result
}

module.exports = { bazelSandboxPlugin }
