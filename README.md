# Mori Pet Player

讓使用者匯入 Mori Sprite Studio 匯出的 `.moripack.zip`，在桌面上陪角色走走、停停、睡覺，也能用滑鼠抓起來移動。

這是獨立的小程式，不需要安裝整套 Mori Desktop。角色包留在使用者的電腦上處理。

## 目前功能

- 讀取 MoriPack v1 的 `sprites/idle.png`，並支援選用 `sleeping.png`、`walking.png`、`dragging.png`。
- 每隔一段時間在目前螢幕隨機漫步；可在設定中關閉。
- 可設定閒置多久後播放 sleeping；使用者互動時會喚醒。
- 角色包沒有 walking 或 dragging 時，對應動作使用 idle。
- 匯入檔案路徑與小程式設定會記住，下一次啟動會載入上次的角色包。
- Linux AppImage、macOS `.app` ZIP、Windows 免安裝 ZIP 的跨平台打包流程。

角色圖須為透明 PNG，尺寸為 1024 × 1024，使用 4 × 4 動畫格。`manifest.json` 須位於 ZIP 根目錄。

## 操作方式

1. 啟動程式後匯入 Studio 匯出的 `.moripack.zip`。
2. 用滑鼠拖曳角色即可移動牠。
3. 點角色旁的齒輪或在角色上按右鍵，開啟漫步、睡眠和動畫設定。
4. 從設定面板可以更換角色包或結束程式。

## 開發

需要 Node.js、Rust，以及 Tauri 2 對應作業系統的建置依賴。

```sh
npm ci
npm run tauri -- dev
```

本機打包時，可依作業系統使用：

```sh
npm run tauri -- build --bundles appimage
npm run tauri -- build --bundles app
npm run tauri -- build --no-bundle
```

GitHub Actions 會分別建置 Linux、macOS 與 Windows portable 成品，供工作流程下載。這個 repo 尚未設定對外發布。

## Portable 成品說明

- **Linux**：x64 AppImage，不需安裝 Mori Desktop；系統需有 WebKitGTK 4.1、圖形桌面與 FUSE。透明浮動視窗會優先走 XWayland；Linux 桌面環境仍可能影響視窗漫步或置頂行為。
- **macOS**：Apple Silicon ARM64 與 Intel x64 各提供一份 ZIP，內含 `.app`。尚未設定 Apple 簽章與公證，首次開啟可能需要使用者在 macOS 安全性設定中允許。
- **Windows**：ZIP 內含獨立 `.exe`，不執行安裝程式。系統須有 Microsoft Edge WebView2 Runtime；Windows 10 1803 以上通常已內建。

Portable 是指程式本身不安裝 Mori Desktop，也不需要安裝步驟；作業系統提供的圖形環境與 WebView 執行環境仍是必要條件。
