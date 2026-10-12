import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  availableMonitors,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

type VisualState = "idle" | "sleeping" | "walking" | "dragging";

type Pack = {
  package_name: string;
  display_name: string;
  idle: string;
  sleeping: string | null;
  walking: string | null;
  dragging: string | null;
  durations_ms: Record<string, number>;
};

type Settings = {
  wander: boolean;
  sleeping: boolean;
  sleepAfterMinutes: number;
  useWalking: boolean;
  useDragging: boolean;
};

const SETTINGS_KEY = "mori-pet-player.settings.v1";
const PACK_PATH_KEY = "mori-pet-player.last-pack-path";
const DEFAULT_SETTINGS: Settings = {
  wander: true,
  sleeping: true,
  sleepAfterMinutes: 1,
  useWalking: true,
  useDragging: true,
};
const WINDOW_EDGE = 184;

function readSettings(): Settings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function assetUrl(value: string | null | undefined): string | undefined {
  return value ? `url("data:image/png;base64,${value}")` : undefined;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(readSettings);
  const savedPath = localStorage.getItem(PACK_PATH_KEY);
  const [settingsOpen, setSettingsOpen] = useState(!savedPath);
  const [pack, setPack] = useState<Pack | null>(null);
  const [isWalking, setIsWalking] = useState(false);
  const [walkLeft, setWalkLeft] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSleeping, setIsSleeping] = useState(false);
  const [error, setError] = useState("");

  const lastActivity = useRef(Date.now());
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const movedListener = useRef<(() => void) | null>(null);
  const dragTimer = useRef<number | undefined>(undefined);
  const settingsRef = useRef(settings);
  const packRef = useRef(pack);
  const settingsOpenRef = useRef(settingsOpen);
  const isWalkingRef = useRef(isWalking);
  const isDraggingRef = useRef(isDragging);
  const isSleepingRef = useRef(isSleeping);

  settingsRef.current = settings;
  packRef.current = pack;
  settingsOpenRef.current = settingsOpen;
  isWalkingRef.current = isWalking;
  isDraggingRef.current = isDragging;
  isSleepingRef.current = isSleeping;

  const noteActivity = () => {
    lastActivity.current = Date.now();
    setIsSleeping(false);
  };

  const applySettings = (patch: Partial<Settings>) => {
    noteActivity();
    setSettings((current) => ({ ...current, ...patch }));
  };

  const loadPack = async (path: string) => {
    setError("");
    try {
      const loaded = await invoke<Pack>("load_pack_from_path", { path });
      setPack(loaded);
      setIsWalking(false);
      setIsSleeping(false);
      setSettingsOpen(false);
      lastActivity.current = Date.now();
      localStorage.setItem(PACK_PATH_KEY, path);
      return true;
    } catch (cause) {
      const message = String(cause);
      setError(message);
      setSettingsOpen(true);
      return false;
    }
  };

  const choosePack = async () => {
    noteActivity();
    try {
      const path = await open({
        multiple: false,
        title: "匯入 MoriPack",
        filters: [{ name: "MoriPack 角色包", extensions: ["zip"] }],
      });
      if (typeof path === "string") await loadPack(path);
    } catch (cause) {
      setError(`無法開啟檔案選擇器：${String(cause)}`);
    }
  };

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!savedPath) return;
    void loadPack(savedPath).then((loaded) => {
      if (!loaded) setSettingsOpen(true);
    });
    // Load the last selected local pack once on startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const height = settingsOpen ? (pack ? 580 : 420) : WINDOW_EDGE;
    const width = settingsOpen ? 260 : WINDOW_EDGE;
    const appWindow = getCurrentWindow();
    void (async () => {
      await appWindow.setSize(new LogicalSize(width, height));
      if (!settingsOpen) return;

      const position = await appWindow.outerPosition();
      const factor = await appWindow.scaleFactor();
      const monitors = await availableMonitors().catch(() => []);
      const centerX = position.x + (width * factor) / 2;
      const centerY = position.y + (height * factor) / 2;
      let monitor = monitors.find((item) => {
        return (
          centerX >= item.position.x &&
          centerX < item.position.x + item.size.width &&
          centerY >= item.position.y &&
          centerY < item.position.y + item.size.height
        );
      });
      if (!monitor) monitor = (await primaryMonitor().catch(() => null)) ?? undefined;
      if (!monitor) return;

      const scale = monitor.scaleFactor || factor;
      const left = monitor.position.x / scale;
      const top = monitor.position.y / scale;
      const maxX = left + monitor.size.width / scale - width - 8;
      const maxY = top + monitor.size.height / scale - height - 8;
      const x = Math.max(left + 8, Math.min(position.x / factor, maxX));
      const y = Math.max(top + 8, Math.min(position.y / factor, maxY));
      await appWindow.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
    })().catch(() => undefined);
  }, [settingsOpen, pack]);

  useEffect(() => {
    if (!settings.sleeping || !pack?.sleeping) {
      setIsSleeping(false);
      return;
    }
    const interval = window.setInterval(() => {
      const timeout = settingsRef.current.sleepAfterMinutes * 60_000;
      const inactiveLongEnough = Date.now() - lastActivity.current >= timeout;
      setIsSleeping(
        inactiveLongEnough &&
          !isDraggingRef.current &&
          !isWalkingRef.current &&
          !settingsOpenRef.current,
      );
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [settings.sleeping, settings.sleepAfterMinutes, pack?.sleeping]);

  useEffect(() => {
    let cancelled = false;
    let pendingTimer: number | undefined;
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        pendingTimer = window.setTimeout(resolve, ms);
      });

    const canWander = () => {
      const current = settingsRef.current;
      return (
        current.wander &&
        Boolean(packRef.current) &&
        !settingsOpenRef.current &&
        !isDraggingRef.current &&
        !isSleepingRef.current
      );
    };

    const moveToRandomSpot = async () => {
      const appWindow = getCurrentWindow();
      const currentPosition = await appWindow.outerPosition();
      const monitors = await availableMonitors().catch(() => []);
      const factor = await appWindow.scaleFactor();
      const centerX = currentPosition.x + (WINDOW_EDGE * factor) / 2;
      const centerY = currentPosition.y + (WINDOW_EDGE * factor) / 2;
      let monitor = monitors.find((item) => {
        return (
          centerX >= item.position.x &&
          centerX < item.position.x + item.size.width &&
          centerY >= item.position.y &&
          centerY < item.position.y + item.size.height
        );
      });
      if (!monitor) monitor = (await primaryMonitor().catch(() => null)) ?? undefined;
      if (!monitor) return;

      const scale = monitor.scaleFactor || factor;
      const left = monitor.position.x / scale;
      const top = monitor.position.y / scale;
      const width = monitor.size.width / scale;
      const height = monitor.size.height / scale;
      const pad = 14;
      const maxX = Math.max(left + pad, left + width - WINDOW_EDGE - pad);
      const maxY = Math.max(top + pad, top + height - WINDOW_EDGE - pad);
      const fromX = currentPosition.x / factor;
      const fromY = currentPosition.y / factor;
      const toX = left + pad + Math.random() * Math.max(0, maxX - left - pad);
      const toY = top + pad + Math.random() * Math.max(0, maxY - top - pad);
      const duration = 1_500;

      setWalkLeft(toX < fromX);
      setIsWalking(true);
      const startedAt = performance.now();
      while (!cancelled && canWander()) {
        const progress = Math.min(1, (performance.now() - startedAt) / duration);
        const eased =
          progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        const x = fromX + (toX - fromX) * eased;
        const y = fromY + (toY - fromY) * eased;
        await appWindow.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
        if (progress >= 1) break;
        await pause(32);
      }
      setIsWalking(false);
    };

    const wanderLoop = async () => {
      while (!cancelled) {
        await pause(500);
        if (!canWander()) continue;
        const waitFor = 4_000 + Math.random() * 5_000;
        let elapsed = 0;
        while (!cancelled && elapsed < waitFor) {
          await pause(250);
          elapsed += 250;
          if (!canWander()) break;
        }
        if (cancelled || !canWander()) continue;
        try {
          await moveToRandomSpot();
        } catch {
          // Some Linux compositors do not let client windows choose their own position.
          setIsWalking(false);
        }
      }
    };

    void wanderLoop();
    return () => {
      cancelled = true;
      if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
      setIsWalking(false);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (dragTimer.current !== undefined) window.clearTimeout(dragTimer.current);
      movedListener.current?.();
    };
  }, []);

  const finishDragging = () => {
    dragStart.current = null;
    if (dragTimer.current !== undefined) window.clearTimeout(dragTimer.current);
    dragTimer.current = undefined;
    movedListener.current?.();
    movedListener.current = null;
    setIsDragging(false);
    isDraggingRef.current = false;
    lastActivity.current = Date.now();
  };

  const beginDragging = async () => {
    if (isDraggingRef.current) return;
    isDraggingRef.current = true;
    noteActivity();
    setIsWalking(false);
    setIsDragging(true);
    try {
      movedListener.current = await getCurrentWindow().onMoved(() => {
        if (dragTimer.current !== undefined) window.clearTimeout(dragTimer.current);
        dragTimer.current = window.setTimeout(finishDragging, 220);
      });
      dragTimer.current = window.setTimeout(finishDragging, 5_000);
      await getCurrentWindow().startDragging();
    } catch {
      finishDragging();
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    dragStart.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start || isDraggingRef.current) return;
    if (Math.abs(event.clientX - start.x) > 5 || Math.abs(event.clientY - start.y) > 5) {
      void beginDragging();
    }
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    noteActivity();
    setSettingsOpen((current) => !current);
  };

  const visual: VisualState = isDragging
    ? settings.useDragging && pack?.dragging
      ? "dragging"
      : "idle"
    : isWalking
      ? settings.useWalking && pack?.walking
        ? "walking"
        : "idle"
      : isSleeping && settings.sleeping && pack?.sleeping
        ? "sleeping"
        : "idle";
  const sprite = pack?.[visual] ?? pack?.idle;
  const duration = pack?.durations_ms[visual] ?? pack?.durations_ms.idle ?? 3_000;
  const spriteStyle = {
    backgroundImage: assetUrl(sprite),
    "--duration": `${duration}ms`,
    "--quarter-duration": `${duration / 4}ms`,
    transform: visual === "walking" && walkLeft ? "scaleX(-1)" : undefined,
  } as CSSProperties;

  return (
    <main className={settingsOpen ? "player player-open" : "player"}>
      <section
        className="stage"
        aria-label={pack ? `${pack.display_name} 桌面夥伴` : "Mori 桌面夥伴"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDragging}
        onPointerCancel={finishDragging}
        onContextMenu={onContextMenu}
      >
        <div className={`sprite sprite-${visual}`} style={spriteStyle} />
        <button
          className="settings-button"
          type="button"
          title="開啟設定"
          aria-label="開啟設定"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            noteActivity();
            setSettingsOpen((current) => !current);
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
            <path d="m19.4 13.5 1.3 1-1.5 2.6-1.6-.6a7.8 7.8 0 0 1-1.6.9l-.3 1.7h-3l-.3-1.7a7.8 7.8 0 0 1-1.6-.9l-1.6.6-1.5-2.6 1.3-1a7 7 0 0 1 0-1.9l-1.3-1 1.5-2.6 1.6.6a7.8 7.8 0 0 1 1.6-.9l.3-1.7h3l.3 1.7a7.8 7.8 0 0 1 1.6.9l1.6-.6 1.5 2.6-1.3 1a7 7 0 0 1 0 1.9Z" />
          </svg>
        </button>
      </section>

      {settingsOpen && (
        <section className="panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">MORI PET PLAYER</p>
              <h1>{pack ? pack.display_name : "先匯入角色包"}</h1>
            </div>
            <button
              type="button"
              className="icon-button"
              title="結束程式"
              aria-label="結束程式"
              onClick={() => void getCurrentWindow().close()}
            >
              ×
            </button>
          </header>

          {!pack ? (
            <div className="empty-state">
              <p>載入 Studio 匯出的 .moripack.zip，讓角色出現在桌面上。</p>
              <button type="button" className="primary-button" onClick={() => void choosePack()}>
                匯入 .moripack.zip
              </button>
            </div>
          ) : (
            <>
              <p className="pack-caption">{pack.package_name}.moripack</p>
              <div className="settings-list">
                <label className="setting-row">
                  <span>
                    <strong>自動漫步</strong>
                    <small>每隔幾秒在目前螢幕換個位置</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.wander}
                    onChange={(event) => applySettings({ wander: event.currentTarget.checked })}
                  />
                </label>

                <label className={`setting-row ${!pack.sleeping ? "setting-disabled" : ""}`}>
                  <span>
                    <strong>閒置時播放 sleeping</strong>
                    <small>{pack.sleeping ? "碰一下角色就會醒來" : "這個角色包沒有 sleeping.png"}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.sleeping && Boolean(pack.sleeping)}
                    disabled={!pack.sleeping}
                    onChange={(event) => applySettings({ sleeping: event.currentTarget.checked })}
                  />
                </label>

                <label className="setting-row sub-setting">
                  <span>閒置多久後睡著</span>
                  <select
                    value={settings.sleepAfterMinutes}
                    disabled={!settings.sleeping || !pack.sleeping}
                    onChange={(event) =>
                      applySettings({ sleepAfterMinutes: Number(event.currentTarget.value) })
                    }
                  >
                    {[1, 3, 5, 10].map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes} 分鐘
                      </option>
                    ))}
                  </select>
                </label>

                <label className={`setting-row compact-row ${!pack.walking ? "setting-disabled" : ""}`}>
                  <span>
                    <strong>漫步時使用 walking</strong>
                    <small>{pack.walking ? "沒有時使用 idle" : "沒有 walking.png，漫步時使用 idle"}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.useWalking && Boolean(pack.walking)}
                    disabled={!pack.walking}
                    onChange={(event) => applySettings({ useWalking: event.currentTarget.checked })}
                  />
                </label>

                <label className={`setting-row compact-row ${!pack.dragging ? "setting-disabled" : ""}`}>
                  <span>
                    <strong>抓起時使用 dragging</strong>
                    <small>{pack.dragging ? "沒有時使用 idle" : "沒有 dragging.png，抓起時使用 idle"}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.useDragging && Boolean(pack.dragging)}
                    disabled={!pack.dragging}
                    onChange={(event) => applySettings({ useDragging: event.currentTarget.checked })}
                  />
                </label>
              </div>

              <div className="panel-actions">
                <button type="button" className="secondary-button" onClick={() => void choosePack()}>
                  更換角色包
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    noteActivity();
                    setSettingsOpen(false);
                  }}
                >
                  收起設定
                </button>
              </div>
            </>
          )}
          {error && <p role="alert" className="error-message">{error}</p>}
          <p className="panel-hint">拖曳角色可移動；右鍵或點齒輪開啟設定。</p>
        </section>
      )}
    </main>
  );
}
