# 由 scripts/package-fedora.sh 驱动（Fedora 容器内 rpmbuild）
# 内嵌 electron 运行时（与开发/联调版本一致，避免发行版 electron 版本漂移）
# 源包由脚本从 release/linux-unpacked 组装（Source0），rpmbuild 不做网络构建

%define debug_package %{nil}
%define _binaries_in_noarch_packages_terminate_build 0

Name:           openbuilder-desktop
Version:        0.1.0
Release:        1%{?dist}
Summary:        Thin desktop client for opencode server (Electron + React)
License:        MIT
URL:            https://github.com/cyrasafia/openbuilder-desktop
Packager:       cyrasafia <cyrasafia@users.noreply.github.com>
Source0:        %{name}-%{version}.tar.xz
Source1:        %{name}.desktop
BuildArch:      x86_64
# 运行时库依赖（electron 43 发行版要求，参照 Chromium fedora 打包惯例）
Requires:       alsa-lib, gtk3, nss, libXtst, libXScrnSaver, libnotify, libgcrypt, cups-libs, hicolor-icon-theme
AutoReqProv:    no

%description
Thin desktop client for opencode server (Electron + React),
optimized for GNOME/Wayland. Talks directly to the opencode HTTP/SSE API.

%prep
%setup -q -n %{name}-%{version}

%build
# 预构建产物，无编译步骤

%install
appdir=%{buildroot}%{_libdir}/%{name}
install -dm755 "$appdir"
cp -a app/. "$appdir/"

# chrome-sandbox 需要 setuid root（无 user namespaces 时的 zygote 沙箱）
chmod 4755 "$appdir/chrome-sandbox"

install -dm755 %{buildroot}%{_bindir}
# 相对符号链接（rpm 不喜欢绝对链接）
ln -s ../lib64/%{name}/%{name} %{buildroot}%{_bindir}/%{name}

install -Dm644 %{SOURCE1} %{buildroot}%{_datadir}/applications/%{name}.desktop
# 图标（hicolor 全尺寸集，随 Source0 内 icons/ 提供，由 scripts/gen-icons.sh 生成）
for s in 16 24 32 48 64 128 256 512; do
  install -Dm644 icons/$s.png %{buildroot}%{_datadir}/icons/hicolor/${s}x${s}/apps/%{name}.png
done

%files
%{_bindir}/%{name}
%{_libdir}/%{name}/
%{_datadir}/applications/%{name}.desktop
%{_datadir}/icons/hicolor/16x16/apps/%{name}.png
%{_datadir}/icons/hicolor/24x24/apps/%{name}.png
%{_datadir}/icons/hicolor/32x32/apps/%{name}.png
%{_datadir}/icons/hicolor/48x48/apps/%{name}.png
%{_datadir}/icons/hicolor/64x64/apps/%{name}.png
%{_datadir}/icons/hicolor/128x128/apps/%{name}.png
%{_datadir}/icons/hicolor/256x256/apps/%{name}.png
%{_datadir}/icons/hicolor/512x512/apps/%{name}.png

%changelog
* Sun Aug 23 2026 cyrasafia <cyrasafia@users.noreply.github.com> - 0.1.0-1
- Initial packaging
