import type { Configuration } from "electron-builder"

/**
 * 仅用于产出 unpacked 运行时（--dir）；Arch 打包由 release/arch/PKGBUILD + makepkg 完成
 * （electron-builder 的 pacman target 依赖 fpm/ruby，其 libcrypt.so.1 依赖在 Arch 上需
 * libxcrypt-compat，故绕开）。
 */
const config: Configuration = {
  appId: "dev.openbuilder.desktop",
  productName: "openbuilder-desktop",
  copyright: "MIT",
  directories: {
    output: "release",
    buildResources: "build",
  },
  files: ["out/**"],
  linux: {
    target: [{ target: "dir", arch: ["x64"] }],
    category: "Development",
    icon: "build/icon.png",
  },
}

export default config
