import Fs from 'node:fs'
import Path from 'node:path'
import { execSync } from 'node:child_process'
import * as Tar from 'tar'

const ROOT = Path.join(import.meta.dirname, '..')
const OUT = Path.join(ROOT, 'out')
const PUBLISH = Path.join(ROOT, 'publish')

const pkg = JSON.parse(Fs.readFileSync(Path.join(ROOT, 'package.json')).toString())
const version = pkg.version
const { platform, arch } = process

const [ , owner, repo ] = pkg.repository.url.match(/([^/:]+)\/([^/]+).git$/u)
const assetName = `ANGLE-v${version}-${platform}-${arch}.tar.gz`

const commonHeaders = {
	"Accept": 'application/vnd.github+json',
	"Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
	'User-Agent': `${repo}@${version}`,
}

async function ghFetch(url, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: { ...commonHeaders, ...options.headers },
	})
	if (!response.ok && response.status !== 404) {
		const body = await response.text()
		throw new Error(`GitHub API error ${response.status}: ${body}`)
	}
	return response
}

// Get or create release
let releaseId
const tagName = `v${version}`

console.log('Getting release for', tagName)
let response = await ghFetch(
	`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tagName}`
)

if (response.ok) {
	releaseId = (await response.json()).id
	console.log('Release exists, id:', releaseId)
} else {
	console.log('Creating release', tagName)
	response = await ghFetch(
		`https://api.github.com/repos/${owner}/${repo}/releases`,
		{
			method: 'POST',
			body: JSON.stringify({
				tag_name: tagName,
				name: tagName,
				prerelease: false,
				make_latest: 'true',
			}),
		},
	)
	releaseId = (await response.json()).id
	console.log('Created release, id:', releaseId)
}

// Create archive
console.log('Creating archive', assetName)
await Fs.promises.rm(PUBLISH, { recursive: true }).catch(() => {})
await Fs.promises.mkdir(PUBLISH, { recursive: true })
const assetPath = Path.join(PUBLISH, assetName)

process.chdir(OUT)
await Tar.create(
	{ gzip: true, file: assetPath },
	['include', 'lib'],
)
const buffer = await Fs.promises.readFile(assetPath)
console.log(`Archive size: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`)

// Delete existing asset if present
response = await ghFetch(
	`https://api.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets`
)
const assets = await response.json()
const existing = assets.find((a) => a.name === assetName)
if (existing) {
	console.log('Deleting existing asset', assetName)
	await ghFetch(
		`https://api.github.com/repos/${owner}/${repo}/releases/assets/${existing.id}`,
		{ method: 'DELETE' },
	)
}

// Upload
console.log('Uploading', assetName)
await ghFetch(
	`https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${assetName}`,
	{
		method: 'POST',
		headers: { 'Content-Type': 'application/gzip' },
		body: buffer,
	},
)

console.log('Done!')
