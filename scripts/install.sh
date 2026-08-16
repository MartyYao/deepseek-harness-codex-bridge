#!/usr/bin/env bash
# dsh-codex-bridge 安装辅助：
#   1. 把插件装入 dsh web profile（pnpm add file: + dsh.profile.bundles 条目）
#   2. 写入并加载 codex app-server 的 launchd plist（崩溃自愈，ws://127.0.0.1:4500）
# 幂等：重复执行会跳过已完成的部分。
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/${PROFILE}"
APP_SERVER_URL="ws://127.0.0.1:4500"
PLIST_LABEL="ai.dsh.codex-app-server"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

echo "==> 插件目录: ${PLUGIN_DIR}"
echo "==> dsh profile: ${PROFILE} (${PROFILE_DIR})"

if [[ ! -d "${PROFILE_DIR}" ]]; then
	echo "!! profile 目录不存在: ${PROFILE_DIR}（先运行一次 dsh --profile ${PROFILE} 让它初始化）" >&2
	exit 1
fi

# ---- 1. 装入 dsh profile ----
if grep -q '"dsh-codex-bridge"' "${PROFILE_DIR}/package.json"; then
	echo "==> 插件已在 profile package.json 中，跳过 pnpm add"
else
	echo "==> pnpm add 插件到 profile"
	dsh plugin --profile "${PROFILE}" add "file:${PLUGIN_DIR}"
fi

# bundles 数组加条目（pnpm 不会动 dsh.profile.bundles）
node - "${PROFILE_DIR}/package.json" <<'EOF'
const fs = require("fs");
const path = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes("dsh-codex-bridge")) {
	pkg.dsh.profile.bundles.push("dsh-codex-bridge");
	fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
	console.log("==> bundles 已加入 dsh-codex-bridge");
} else {
	console.log("==> bundles 已包含 dsh-codex-bridge，跳过");
}
EOF

# ---- 2. app-server launchd ----
CODEX_BIN="$(command -v codex || true)"
if [[ -z "${CODEX_BIN}" ]]; then
	echo "!! 未找到 codex CLI（command -v codex 为空），跳过 launchd 安装" >&2
	echo "   请先安装 codex 并 `codex login`" >&2
	exit 1
fi
# launchd 需要符号链接解析后的真实路径；macOS 的 BSD readlink 不支持 -f，逐层解析
while [[ -L "${CODEX_BIN}" ]]; do
	LINK_DIR="$(cd "$(dirname "${CODEX_BIN}")" && pwd)"
	LINK_TARGET="$(readlink "${CODEX_BIN}")"
	if [[ "${LINK_TARGET}" == /* ]]; then
		CODEX_BIN="${LINK_TARGET}"
	else
		CODEX_BIN="${LINK_DIR}/${LINK_TARGET}"
	fi
done
echo "==> codex 二进制: ${CODEX_BIN}"

if [[ -f "${PLIST_PATH}" ]]; then
	echo "==> plist 已存在: ${PLIST_PATH}，跳过写入"
else
	cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CODEX_BIN}</string>
    <string>app-server</string>
    <string>--listen</string>
    <string>${APP_SERVER_URL}</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/codex-app-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/codex-app-server.err</string>
</dict>
</plist>
EOF
	echo "==> 已写入 ${PLIST_PATH}"
fi

if launchctl list | grep -q "${PLIST_LABEL}"; then
	echo "==> launchd 服务已在运行"
else
	launchctl load "${PLIST_PATH}"
	echo "==> launchd 服务已加载（${PLIST_LABEL}）"
fi

echo
echo "完成。重启 dsh 后在对话中说「用 GPT …」即可触发 codex 工具。"
echo "健康检查: curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:4500/readyz"
echo "集成验证: node ${PLUGIN_DIR}/scripts/verify-integration.mjs"
