// Which build to fetch for a given machine.
//
// Two providers:
//
//   lemonade — llama.cpp + ROCm with the runtime bundled in, one archive per
//              GPU family. This is the only Windows AMD build that works
//              without a separate ROCm install; the official ROCm asset loads
//              but silently runs on the CPU.
//
//   official — ggml-org/llama.cpp releases. CUDA for NVIDIA, Vulkan for
//              everything else, Metal on macOS.
//
// Official releases publish no checksums, so their hashes are pinned here and
// were computed once from the downloaded asset. Lemonade publishes a
// checksums.txt per release, so its hash is fetched with the release instead.

export const OFFICIAL_BUILD = 'b12284'

// AMD GPU name -> lemonade gfx family. An unmatched card falls back to Vulkan,
// which is slower but always works. Extend this table as cards are confirmed.
const AMD_GFX = [
  [/rx\s*9[05]\d0|r9700|r9600/i, 'gfx120X'],
  [/rx\s*7[789]\d0|rx\s*76\d0|w7[89]00|v710|780m|760m|740m/i, 'gfx110X'],
  [/rx\s*6[6-9]\d0|w6800|v620/i, 'gfx103X'],
  [/890m|880m/i, 'gfx1150'],
  [/860m|840m/i, 'gfx1152'],
  [/820m/i, 'gfx1153'],
  [/8060s|8050s|8040s|ai max/i, 'gfx1151'],
]

export function amdGfx(name) {
  for (const [re, gfx] of AMD_GFX) if (re.test(name)) return gfx
  return null
}

/**
 * Pick a build for this machine. Returns a descriptor the installer can turn
 * into a download, or null when we have nothing trustworthy to offer.
 */
export function pickSource({ os, arch, gpu }) {
  if (os === 'darwin') {
    const a = arch === 'arm64' ? 'arm64' : 'x64'
    return {
      provider: 'official',
      asset: `llama-${OFFICIAL_BUILD}-bin-macos-${a}.tar.gz`,
      kind: 'tar.gz',
      label: `llama.cpp ${OFFICIAL_BUILD} · Metal`,
    }
  }

  if (os === 'win32') {
    if (gpu.vendor === 'amd') {
      const gfx = amdGfx(gpu.name)
      if (gfx) {
        return {
          provider: 'lemonade',
          gfx,
          kind: 'zip',
          label: `llama.cpp + ROCm · ${gfx}`,
        }
      }
    }
    if (gpu.vendor === 'nvidia') {
      return {
        provider: 'official',
        asset: `llama-${OFFICIAL_BUILD}-bin-win-cuda-13.5-x64.zip`,
        kind: 'zip',
        label: `llama.cpp ${OFFICIAL_BUILD} · CUDA 13.5`,
      }
    }
    return {
      provider: 'official',
      asset: `llama-${OFFICIAL_BUILD}-bin-win-vulkan-x64.zip`,
      kind: 'zip',
      label: `llama.cpp ${OFFICIAL_BUILD} · Vulkan`,
    }
  }

  if (os === 'linux') {
    if (gpu.vendor === 'amd') {
      return {
        provider: 'official',
        asset: `llama-${OFFICIAL_BUILD}-bin-ubuntu-rocm-10.0-x64.tar.gz`,
        kind: 'tar.gz',
        label: `llama.cpp ${OFFICIAL_BUILD} · ROCm 10.0`,
      }
    }
    if (gpu.vendor === 'nvidia') {
      return {
        provider: 'official',
        asset: `llama-${OFFICIAL_BUILD}-bin-ubuntu-cuda-13.5-x64.tar.gz`,
        kind: 'tar.gz',
        label: `llama.cpp ${OFFICIAL_BUILD} · CUDA 13.5`,
      }
    }
    return {
      provider: 'official',
      asset: `llama-${OFFICIAL_BUILD}-bin-ubuntu-vulkan-x64.tar.gz`,
      kind: 'tar.gz',
      label: `llama.cpp ${OFFICIAL_BUILD} · Vulkan`,
    }
  }

  return null
}
