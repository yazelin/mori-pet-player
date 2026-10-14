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
import { SettingSelect } from "./SettingSelect";

type VisualState = "idle" | "sleeping" | "walking" | "dragging";

type Pack = {
  package_name: string;
  display_name: string;
  idle: string;
  sleeping: string | null;
  walking: string | null;
  dragging: string | null;
  durations_ms: Record<string, number>;
  custom_actions: CustomAction[];
};

type CustomAction = {
  id: string;
  display_name: string;
  playback: "loop" | "one-shot";
  duration_ms: number;
  sprite: string;
};

type ActionTriggers = {
  onClick: boolean;
  idleAfterMinutes: number;
  randomEveryMinutes: number;
};

type Settings = {
  wander: boolean;
  wanderSpeedPercent: number;
  sleeping: boolean;
  sleepAfterMinutes: number;
  useWalking: boolean;
  useDragging: boolean;
  actionTriggers: Record<string, ActionTriggers>;
};

const SETTINGS_KEY = "mori-pet-player.settings.v1";
const PACK_PATH_KEY = "mori-pet-player.last-pack-path";
const DEFAULT_SETTINGS: Settings = {
  wander: true,
  wanderSpeedPercent: 10,
  sleeping: true,
  sleepAfterMinutes: 1,
  useWalking: true,
  useDragging: true,
  actionTriggers: {},
};
const DEFAULT_ACTION_TRIGGERS: ActionTriggers = {
  onClick: false,
  idleAfterMinutes: 0,
  randomEveryMinutes: 0,
};
const WINDOW_EDGE = 184;

function readSettings(): Settings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(saved) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      actionTriggers: parsed.actionTriggers && typeof parsed.actionTriggers === "object"
        ? parsed.actionTriggers
        : {},
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function assetUrl(value: string | null | undefined): string | undefined {
  return value ? `url("data:image/png;base64,${value}")` : undefined;
}

function randomIntervalMs(minutes: number): number {
  const average = Math.max(1, minutes) * 60_000;
  return Math.round(average * (0.75 + Math.random() * 0.5));
}

function normalizeActionTriggers(value?: Partial<ActionTriggers>): ActionTriggers {
  const idleAfterMinutes = typeof value?.idleAfterMinutes === "number"
    && [1, 3, 5, 10, 20].includes(value.idleAfterMinutes)
    ? value.idleAfterMinutes
    : 0;
  const randomEveryMinutes = typeof value?.randomEveryMinutes === "number"
    && [2, 5, 10, 15, 30].includes(value.randomEveryMinutes)
    ? value.randomEveryMinutes
    : 0;
  return { onClick: value?.onClick === true, idleAfterMinutes, randomEveryMinutes };
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
  const [activeAction, setActiveAction] = useState<{ id: string; token: number } | null>(null);
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
  const activeActionRef = useRef(activeAction);
  const actionTokenRef = useRef(0);
  const idleActionsFiredRef = useRef(new Set<string>());
  const randomDueAtRef = useRef<Record<string, { minutes: number; at: number }>>({});
  const suppressClickRef = useRef(false);

  settingsRef.current = settings;
  packRef.current = pack;
  settingsOpenRef.current = settingsOpen;
  isWalkingRef.current = isWalking;
  isDraggingRef.current = isDragging;
  isSleepingRef.current = isSleeping;
  activeActionRef.current = activeAction;

  const noteActivity = () => {
    lastActivity.current = Date.now();
    setIsSleeping(false);
    setActiveAction(null);
    idleActionsFiredRef.current.clear();
  };

  const applySettings = (patch: Partial<Settings>) => {
    noteActivity();
    setSettings((current) => ({ ...current, ...patch }));
  };

  const triggersFor = (actionId: string) => normalizeActionTriggers(settings.actionTriggers[actionId]);

  const updateActionTriggers = (actionId: string, patch: Partial<ActionTriggers>) => {
    noteActivity();
    setSettings((current) => ({
      ...current,
      actionTriggers: {
        ...current.actionTriggers,
        [actionId]: {
          ...(current.actionTriggers[actionId] ?? DEFAULT_ACTION_TRIGGERS),
          ...patch,
        },
      },
    }));
  };

  const playCustomAction = (actionId: string, countAsActivity = true) => {
    const action = packRef.current?.custom_actions.find((item) => item.id === actionId);
    if (!action) return;
    if (countAsActivity) noteActivity();
    setIsWalking(false);
    setIsSleeping(false);
    setActiveAction({ id: actionId, token: ++actionTokenRef.current });
  };

  const onStageClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const hadAction = Boolean(activeActionRef.current);
    noteActivity();
    if (hadAction) return;
    const candidates = (packRef.current?.custom_actions ?? []).filter(
      (action) => normalizeActionTriggers(settingsRef.current.actionTriggers[action.id]).onClick,
    );
    if (candidates.length > 0) {
      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      playCustomAction(chosen.id, false);
    }
  };

  const loadPack = async (path: string) => {
    setError("");
    try {
      const loaded = await invoke<Pack>("load_pack_from_path", { path });
      setPack(loaded);
      setIsWalking(false);
      setIsSleeping(false);
      setActiveAction(null);
      idleActionsFiredRef.current.clear();
      randomDueAtRef.current = {};
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
    if (!activeAction) return;
    const action = pack?.custom_actions.find((item) => item.id === activeAction.id);
    if (!action || action.playback === "loop") return;
    const token = activeAction.token;
    const timeout = window.setTimeout(() => {
      setActiveAction((current) => current?.token === token ? null : current);
    }, action.duration_ms);
    return () => window.clearTimeout(timeout);
  }, [activeAction, pack]);

  useEffect(() => {
    if (!savedPath) return;
    void loadPack(savedPath).then((loaded) => {
      if (!loaded) setSettingsOpen(true);
    });
    // Load the last selected local pack once on startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const height = settingsOpen ? (pack ? 650 : 420) : WINDOW_EDGE;
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
          !activeActionRef.current &&
          !settingsOpenRef.current,
      );
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [settings.sleeping, settings.sleepAfterMinutes, pack?.sleeping]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const currentPack = packRef.current;
      const currentSettings = settingsRef.current;
      if (
        !currentPack || settingsOpenRef.current || isDraggingRef.current ||
        isWalkingRef.current || activeActionRef.current
      ) return;

      const now = Date.now();
      const idleFor = now - lastActivity.current;
      const idleReady: CustomAction[] = [];
      const randomReady: CustomAction[] = [];
      for (const action of currentPack.custom_actions) {
        const trigger = normalizeActionTriggers(currentSettings.actionTriggers[action.id]);
        if (trigger.idleAfterMinutes > 0 && !idleActionsFiredRef.current.has(action.id)
          && idleFor >= trigger.idleAfterMinutes * 60_000) {
          idleReady.push(action);
        }
        if (trigger.randomEveryMinutes <= 0) {
          delete randomDueAtRef.current[action.id];
          continue;
        }
        const schedule = randomDueAtRef.current[action.id];
        if (!schedule || schedule.minutes !== trigger.randomEveryMinutes) {
          randomDueAtRef.current[action.id] = {
            minutes: trigger.randomEveryMinutes,
            at: now + randomIntervalMs(trigger.randomEveryMinutes),
          };
        } else if (now >= schedule.at) {
          randomReady.push(action);
        }
      }

      if (idleReady.length > 0) {
        for (const action of idleReady) idleActionsFiredRef.current.add(action.id);
        for (const action of randomReady) {
          const trigger = normalizeActionTriggers(currentSettings.actionTriggers[action.id]);
          randomDueAtRef.current[action.id] = {
            minutes: trigger.randomEveryMinutes,
            at: now + randomIntervalMs(trigger.randomEveryMinutes),
          };
        }
        const chosen = idleReady[Math.floor(Math.random() * idleReady.length)];
        playCustomAction(chosen.id, false);
        return;
      }

      if (randomReady.length > 0) {
        for (const action of randomReady) {
          const trigger = normalizeActionTriggers(currentSettings.actionTriggers[action.id]);
          randomDueAtRef.current[action.id] = {
            minutes: trigger.randomEveryMinutes,
            at: now + randomIntervalMs(trigger.randomEveryMinutes),
          };
        }
        const chosen = randomReady[Math.floor(Math.random() * randomReady.length)];
        playCustomAction(chosen.id, false);
      }
    }, 1_000);
    return () => window.clearInterval(interval);
  }, []);

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
        !isSleepingRef.current &&
        !activeActionRef.current
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
      const speedPercent = Math.min(
        100,
        Math.max(10, Number(settingsRef.current.wanderSpeedPercent) || 10),
      );
      const duration = 1_500 * (100 / speedPercent);

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
    suppressClickRef.current = true;
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
    suppressClickRef.current = false;
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
  const selectedAction = activeAction
    ? pack?.custom_actions.find((item) => item.id === activeAction.id) ?? null
    : null;
  const sprite = selectedAction?.sprite ?? pack?.[visual] ?? pack?.idle;
  const duration = selectedAction?.duration_ms ?? pack?.durations_ms[visual] ?? pack?.durations_ms.idle ?? 3_000;
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
        onClick={onStageClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDragging}
        onPointerCancel={finishDragging}
        onContextMenu={onContextMenu}
      >
        <div
          key={activeAction ? `action-${activeAction.token}` : visual}
          className={`sprite ${selectedAction
            ? `sprite-custom-action${selectedAction.playback === "one-shot" ? " sprite-once" : ""}`
            : `sprite-${visual}`}`}
          style={spriteStyle}
        />
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
              title="收起設定"
              aria-label="收起設定"
              onClick={() => {
                noteActivity();
                setSettingsOpen(false);
              }}
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

                <div className="speed-setting">
                  <div className="speed-setting-label">
                    <strong>漫步速度</strong>
                    <span>{settings.wanderSpeedPercent}%</span>
                  </div>
                  <input
                    className="speed-slider"
                    type="range"
                    min={10}
                    max={100}
                    step={5}
                    value={settings.wanderSpeedPercent}
                    disabled={!settings.wander}
                    aria-label="漫步速度"
                    onChange={(event) =>
                      applySettings({ wanderSpeedPercent: Number(event.currentTarget.value) })
                    }
                  />
                  <small>10% 慢速 · 100% 原始速度</small>
                </div>

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

                <div className="setting-row sub-setting">
                  <span>閒置多久後睡著</span>
                  <SettingSelect
                    value={settings.sleepAfterMinutes}
                    disabled={!settings.sleeping || !pack.sleeping}
                    ariaLabel="閒置多久後睡著"
                    options={[1, 3, 5, 10].map((minutes) => ({ value: minutes, label: `${minutes} 分鐘` }))}
                    onChange={(sleepAfterMinutes) => applySettings({ sleepAfterMinutes })}
                  />
                </div>

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

                {pack.custom_actions.length > 0 && (
                  <div className="custom-action-settings">
                    <div className="custom-action-heading">
                      <strong>自訂動作</strong>
                      <small>觸發條件存在這台電腦</small>
                    </div>
                    {pack.custom_actions.map((action) => {
                      const trigger = triggersFor(action.id);
                      const isActive = activeAction?.id === action.id;
                      return (
                        <div className="custom-action-row" key={action.id}>
                          <div className="custom-action-title">
                            <strong>{action.display_name}</strong>
                            <button
                              type="button"
                              className="action-play-button"
                              onClick={() => isActive ? noteActivity() : playCustomAction(action.id)}
                            >
                              {isActive ? "停止" : "播放"}
                            </button>
                          </div>
                          <label className="action-trigger-row">
                            <span>點擊 Mori 時播放</span>
                            <input
                              type="checkbox"
                              checked={trigger.onClick}
                              onChange={(event) => updateActionTriggers(action.id, { onClick: event.currentTarget.checked })}
                            />
                          </label>
                          <div className="action-trigger-row">
                            <span>閒置多久後播放</span>
                            <SettingSelect
                              value={trigger.idleAfterMinutes}
                              ariaLabel={`${action.display_name} 閒置多久後播放`}
                              options={[
                                { value: 0, label: "關閉" },
                                ...[1, 3, 5, 10, 20].map((minutes) => ({ value: minutes, label: `${minutes} 分鐘` })),
                              ]}
                              onChange={(idleAfterMinutes) => updateActionTriggers(action.id, { idleAfterMinutes })}
                            />
                          </div>
                          <div className="action-trigger-row">
                            <span>隨機間隔播放</span>
                            <SettingSelect
                              value={trigger.randomEveryMinutes}
                              ariaLabel={`${action.display_name} 隨機間隔播放`}
                              options={[
                                { value: 0, label: "關閉" },
                                ...[2, 5, 10, 15, 30].map((minutes) => ({ value: minutes, label: `約 ${minutes} 分鐘` })),
                              ]}
                              onChange={(randomEveryMinutes) => updateActionTriggers(action.id, { randomEveryMinutes })}
                            />
                          </div>
                        </div>
                      );
                    })}
                    <p className="custom-action-hint">多個動作同時符合條件時，Player 會隨機挑一個。自動觸發會在設定面板關閉、角色沒有被拖曳或漫步時播放。</p>
                  </div>
                )}
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
          <button
            type="button"
            className="exit-button"
            onClick={() => void getCurrentWindow().close()}
          >
            結束程式
          </button>
          {error && <p role="alert" className="error-message">{error}</p>}
          <p className="panel-hint">左鍵拖曳角色可移動；右鍵角色可開啟或收起設定。</p>
        </section>
      )}
    </main>
  );
}
