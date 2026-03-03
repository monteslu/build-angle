import Fs from 'node:fs'
import Path from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = Path.join(import.meta.dirname, '..')
const WORK = Path.join(ROOT, 'work')
const OUT = Path.join(ROOT, 'out')
const { platform, arch } = process

console.log(`Building ANGLE for ${platform}-${arch}`)

// Clean
await Fs.promises.rm(WORK, { recursive: true }).catch(() => {})
await Fs.promises.rm(OUT, { recursive: true }).catch(() => {})
await Fs.promises.mkdir(WORK, { recursive: true })
await Fs.promises.mkdir(OUT, { recursive: true })
await Fs.promises.mkdir(Path.join(OUT, 'lib'), { recursive: true })
await Fs.promises.mkdir(Path.join(OUT, 'include', 'EGL'), { recursive: true })
await Fs.promises.mkdir(Path.join(OUT, 'include', 'GLES2'), { recursive: true })
await Fs.promises.mkdir(Path.join(OUT, 'include', 'GLES3'), { recursive: true })
await Fs.promises.mkdir(Path.join(OUT, 'include', 'KHR'), { recursive: true })

// Get depot_tools
const depotToolsDir = Path.join(WORK, 'depot_tools')
console.log('Cloning depot_tools...')
execSync(`git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git ${depotToolsDir}`, {
	stdio: 'inherit',
})

const env = {
	...process.env,
	PATH: `${depotToolsDir}${Path.delimiter}${process.env.PATH}`,
	DEPOT_TOOLS_UPDATE: '0',
}

// Fetch ANGLE source
const angleDir = Path.join(WORK, 'angle')
console.log('Fetching ANGLE source...')
await Fs.promises.mkdir(angleDir, { recursive: true })
execSync('fetch angle', {
	stdio: 'inherit',
	cwd: angleDir,
	env,
	timeout: 600000, // 10 min for fetch
})

// Install build deps on Linux
if (platform === 'linux') {
	console.log('Installing Linux build dependencies...')
	execSync('./build/install-build-deps.sh', {
		stdio: 'inherit',
		cwd: Path.join(angleDir, 'angle') || angleDir,
		env,
	})
}

// Find the actual angle source dir (fetch creates angle/angle or just populates angle/)
const angleSrc = Fs.existsSync(Path.join(angleDir, 'src', 'libEGL'))
	? angleDir
	: Path.join(angleDir, 'angle')

console.log('ANGLE source at:', angleSrc)

// GN args — minimal build, just libEGL + libGLESv2
const gnArgs = [
	'is_debug = false',
	'angle_build_all = false',
	'is_component_build = false',
	'angle_has_frame_capture = false',
	'angle_enable_gl = false',        // we don't need the GL backend
	'angle_enable_null = false',
	'angle_enable_essl = false',
	'angle_enable_glsl = false',
]

if (platform === 'darwin') {
	gnArgs.push('angle_enable_metal = true')
	gnArgs.push('angle_enable_vulkan = false')
	gnArgs.push('angle_enable_d3d9 = false')
	gnArgs.push('angle_enable_d3d11 = false')
} else if (platform === 'win32') {
	gnArgs.push('angle_enable_d3d11 = true')
	gnArgs.push('angle_enable_vulkan = false')
	gnArgs.push('angle_enable_metal = false')
	gnArgs.push('angle_enable_d3d9 = false')
}

const buildDir = Path.join(angleSrc, 'out', 'Release')
const gnArgsStr = gnArgs.join('\n')

console.log('GN args:', gnArgsStr)
console.log('Generating build files...')

// Write args.gn directly
await Fs.promises.mkdir(buildDir, { recursive: true })
await Fs.promises.writeFile(Path.join(buildDir, 'args.gn'), gnArgsStr + '\n')

execSync('gn gen out/Release', {
	stdio: 'inherit',
	cwd: angleSrc,
	env,
})

// Build
console.log('Building ANGLE...')
execSync('autoninja -C out/Release libEGL libGLESv2', {
	stdio: 'inherit',
	cwd: angleSrc,
	env,
	timeout: 3600000, // 60 min
})

// Copy outputs
console.log('Copying build artifacts...')

const libExt = platform === 'darwin' ? 'dylib' : platform === 'win32' ? 'dll' : 'so'
const libPrefix = platform === 'win32' ? '' : 'lib'

// Copy libraries
const libFiles = await Fs.promises.readdir(buildDir)
for (const file of libFiles) {
	if (file.startsWith(`${libPrefix}EGL`) || file.startsWith(`${libPrefix}GLES`) || file.startsWith('libchrome_zlib')) {
		const src = Path.join(buildDir, file)
		const stat = await Fs.promises.stat(src)
		if (stat.isFile() && (file.endsWith(`.${libExt}`) || file.endsWith('.lib') || file.endsWith('.dll') || file.endsWith('.so'))) {
			console.log(`  lib: ${file}`)
			await Fs.promises.cp(src, Path.join(OUT, 'lib', file))
		}
	}
}

// Also copy .lib import libraries on Windows
if (platform === 'win32') {
	for (const file of libFiles) {
		if (file.endsWith('.dll.lib') && (file.includes('EGL') || file.includes('GLES'))) {
			console.log(`  import lib: ${file}`)
			await Fs.promises.cp(Path.join(buildDir, file), Path.join(OUT, 'lib', file))
		}
	}
}

// Copy headers from ANGLE source
const includeDir = Path.join(angleSrc, 'include')
const headerDirs = ['EGL', 'GLES2', 'GLES3', 'KHR']
for (const dir of headerDirs) {
	const srcDir = Path.join(includeDir, dir)
	if (Fs.existsSync(srcDir)) {
		const files = await Fs.promises.readdir(srcDir)
		for (const file of files) {
			if (file.endsWith('.h')) {
				console.log(`  header: ${dir}/${file}`)
				await Fs.promises.cp(Path.join(srcDir, file), Path.join(OUT, 'include', dir, file))
			}
		}
	}
}

console.log(`\nANGLE built successfully for ${platform}-${arch}`)
console.log('Output:', OUT)
