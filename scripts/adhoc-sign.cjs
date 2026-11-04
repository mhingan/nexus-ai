// Ad-hoc code signing (free, no Apple Developer account). Keeps the bundle's signature valid
// after electron-builder edits it, so macOS shows the normal first-launch prompt instead of
// "app is damaged". Keychain certificates are never used.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`  • ad-hoc signing  ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
