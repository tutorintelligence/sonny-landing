/* ======================================================================
   Fleet sim — ported from the original SQL deck, lightly trimmed for
   site context (full-viewport stage, no dispatcher rail collapse).

   Three sonnys on a coordinated floor:
   - rAF state machine (single source of truth for both motion + dispatcher)
   - Two-lane highways with explicit direction
   - Aisle semaphore: one robot per aisle; others yield
   - Live dispatcher subscribes to the same store
   ====================================================================== */

const FS_VB_W = 1240;
const FS_VB_H = 600;

const HW_TOP_N = 102;
const HW_TOP_S = 118;
const HW_BOT_N = 502;
const HW_BOT_S = 518;
const FLOOR_TOP = 88;
const FLOOR_BOT = 540;

const AISLES_X = [180, 350, 520, 720, 900, 1070];
const SHELF_W = 60;
const SHELF_TOP_Y = 138;
const SHELF_TOP_H = 175;
const SHELF_BOT_Y = 338;
const SHELF_BOT_H = 175;
const PICK_Y_UPPER = 220;
const PICK_Y_LOWER = 425;

const PACK_STATIONS_FS = [
  { id: "P1", x: 280, label: "PACK·01" },
  { id: "P2", x: 600, label: "PACK·02" },
  { id: "P3", x: 990, label: "PACK·03" },
];

const ROUTE_S01 = {
  id: "S-01", color: "#FFD24C", packId: "P1", speed: 92,
  segments: [
    { x: 280, y: 78,  kind: "dock",  label: "pack · 01",  dwell: 1100 },
    { x: 280, y: HW_TOP_N, kind: "hwy", label: "hwy · north" },
    { x: 350, y: HW_TOP_N, kind: "hwy", label: "hwy · north" },
    { x: 350, y: PICK_Y_UPPER, kind: "aisle", aisle: "A2", label: "A2 · upper", dwell: 1400 },
    { x: 350, y: HW_TOP_N, kind: "aisle", aisle: "A2", label: "A2 · exit" },
    { x: 180, y: HW_TOP_N, kind: "hwy", label: "hwy · north" },
    { x: 180, y: PICK_Y_LOWER, kind: "aisle", aisle: "A1", label: "A1 · lower", dwell: 1400 },
    { x: 180, y: HW_BOT_S, kind: "aisle", aisle: "A1", label: "A1 · exit" },
    { x: 280, y: HW_BOT_S, kind: "hwy", label: "hwy · south" },
    { x: 280, y: HW_TOP_S, kind: "aisle", aisle: "_pack1col", label: "return · pack 01" },
    { x: 280, y: 78,  kind: "dock",  label: "pack · 01",  dwell: 900 },
  ],
};
const ROUTE_S02 = {
  id: "S-02", color: "#73E77D", packId: "P2", speed: 100,
  segments: [
    { x: 600, y: 78,  kind: "dock",  label: "pack · 02",  dwell: 1100 },
    { x: 600, y: HW_TOP_N, kind: "hwy", label: "hwy · north" },
    { x: 520, y: HW_TOP_N, kind: "hwy", label: "hwy · north" },
    { x: 520, y: PICK_Y_UPPER, kind: "aisle", aisle: "A3", label: "A3 · upper", dwell: 1400 },
    { x: 520, y: HW_TOP_N, kind: "aisle", aisle: "A3", label: "A3 · exit" },
    { x: 720, y: HW_TOP_N, kind: "hwy", label: "hwy · north" },
    { x: 720, y: PICK_Y_LOWER, kind: "aisle", aisle: "A4", label: "A4 · lower", dwell: 1400 },
    { x: 720, y: HW_BOT_S, kind: "aisle", aisle: "A4", label: "A4 · exit" },
    { x: 600, y: HW_BOT_S, kind: "hwy", label: "hwy · south" },
    { x: 600, y: HW_TOP_S, kind: "aisle", aisle: "_pack2col", label: "return · pack 02" },
    { x: 600, y: 78,  kind: "dock",  label: "pack · 02",  dwell: 900 },
  ],
};
const ROUTE_S03 = {
  id: "S-03", color: "#8BADFF", packId: "P3", speed: 95,
  segments: [
    { x: 990, y: 78,  kind: "dock",  label: "pack · 03",  dwell: 1100 },
    { x: 990, y: HW_TOP_N, kind: "hwy", label: "hwy · north" },
    { x: 900, y: HW_TOP_N, kind: "hwy", label: "hwy · north" },
    { x: 900, y: PICK_Y_LOWER, kind: "aisle", aisle: "A5", label: "A5 · lower", dwell: 1400 },
    { x: 900, y: HW_BOT_S, kind: "aisle", aisle: "A5", label: "A5 · exit" },
    { x: 1070, y: HW_BOT_S, kind: "hwy", label: "hwy · south" },
    { x: 1070, y: PICK_Y_UPPER, kind: "aisle", aisle: "A6", label: "A6 · upper", dwell: 1400 },
    { x: 1070, y: HW_TOP_N, kind: "aisle", aisle: "A6", label: "A6 · exit" },
    { x: 990, y: HW_TOP_N, kind: "hwy", label: "hwy · north" },
    { x: 990, y: HW_TOP_S, kind: "hwy", label: "approach · pack 03" },
    { x: 990, y: 78,  kind: "dock",  label: "pack · 03",  dwell: 900 },
  ],
};
const FS_ROUTES = [ROUTE_S01, ROUTE_S02, ROUTE_S03];

/* ----- shared store, scene → dispatcher ----- */
const FleetStore = {
  robots: FS_ROUTES.map((r) => ({
    id: r.id, color: r.color, state: "DOCKING",
    location: r.segments[0].label, toteCount: 0, progress: 0,
  })),
  packs: { P1: 0, P2: 0, P3: 0 },
  listeners: new Set(),
  notify() { for (const l of this.listeners) l(); },
  subscribe(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); },
};
function publishFleetState(robots, packs) {
  const totalSegs = FS_ROUTES.map((r) => r.segments.length);
  for (let i = 0; i < robots.length; i++) {
    const rb = robots[i];
    FleetStore.robots[i].state = rb.state;
    FleetStore.robots[i].location = rb.location;
    FleetStore.robots[i].toteCount = rb.toteCount;
    FleetStore.robots[i].progress = rb.segIdx / totalSegs[i];
  }
  FleetStore.packs = { ...packs };
  FleetStore.notify();
}

/* ----- the scene ----- */
function FleetScene({ active = true }) {
  const [, setTick] = React.useState(0);
  const robotsRef = React.useRef(FS_ROUTES.map((r) => ({
    route: r, segIdx: 0,
    pos: { x: r.segments[0].x, y: r.segments[0].y },
    dwellUntil: 0, state: "DOCKING",
    location: r.segments[0].label, trail: [], toteCount: 0,
  })));
  const aisleLockRef = React.useRef({});
  const packCountsRef = React.useRef({ P1: 0, P2: 0, P3: 0 });

  React.useEffect(() => {
    if (!active) return;
    let raf;
    let lastT = performance.now();
    robotsRef.current[0].dwellUntil = lastT + 200;
    robotsRef.current[1].dwellUntil = lastT + 1800;
    robotsRef.current[2].dwellUntil = lastT + 3400;

    function step(now) {
      const dt = Math.min(50, now - lastT) / 1000;
      lastT = now;
      const robots = robotsRef.current;
      const locks = aisleLockRef.current;

      for (const rb of robots) {
        if (now < rb.dwellUntil) continue;
        const segs = rb.route.segments;
        const target = segs[rb.segIdx];
        const dx = target.x - rb.pos.x;
        const dy = target.y - rb.pos.y;
        const dist = Math.hypot(dx, dy);

        if (target.kind === "aisle" && target.aisle && target.aisle.startsWith("A")) {
          const owner = locks[target.aisle];
          if (owner && owner !== rb.route.id) {
            rb.state = "YIELDING";
            rb.location = `wait · ${target.aisle}`;
            continue;
          }
          if (!owner) locks[target.aisle] = rb.route.id;
        }

        if (dist < 1.5) {
          rb.pos.x = target.x; rb.pos.y = target.y;
          if (target.kind === "dock") {
            rb.state = "DOCKING";
            if (rb.segIdx === segs.length - 1) {
              rb.toteCount++;
              packCountsRef.current[rb.route.packId]++;
            }
          } else if (target.kind === "aisle" && (target.label.includes("upper") || target.label.includes("lower"))) {
            rb.state = "PICKING";
          } else {
            rb.state = "TRANSIT";
          }
          rb.location = target.label;
          if (target.dwell) rb.dwellUntil = now + target.dwell;
          const next = segs[(rb.segIdx + 1) % segs.length];
          if (target.aisle && (!next.aisle || next.aisle !== target.aisle)) {
            if (locks[target.aisle] === rb.route.id) delete locks[target.aisle];
          }
          rb.segIdx = (rb.segIdx + 1) % segs.length;
        } else {
          const v = rb.route.speed * dt;
          const stepDist = Math.min(v, dist);
          rb.pos.x += (dx / dist) * stepDist;
          rb.pos.y += (dy / dist) * stepDist;
          rb.state = "TRANSIT";
          rb.location = target.label;
        }

        rb.trail.push({ x: rb.pos.x, y: rb.pos.y, t: now });
        const cutoff = now - 1600;
        while (rb.trail.length && rb.trail[0].t < cutoff) rb.trail.shift();
      }

      setTick((t) => t + 1);
      publishFleetState(robotsRef.current, packCountsRef.current);
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const robots = robotsRef.current;
  return (
    <div className="fs-wrap">
      <svg viewBox={`0 0 ${FS_VB_W} ${FS_VB_H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block" }} aria-label="Live fleet floor with three sonnys">
        <defs>
          <pattern id="fs-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1"/>
          </pattern>
          <linearGradient id="fs-floor" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1a1a18"/><stop offset="100%" stopColor="#0f0f0e"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={FS_VB_W} height={FS_VB_H} fill="url(#fs-floor)"/>
        <rect x="0" y="0" width={FS_VB_W} height={FS_VB_H} fill="url(#fs-grid)"/>

        {[{ y1: HW_TOP_N - 8, y2: HW_TOP_S + 8 }, { y1: HW_BOT_N - 8, y2: HW_BOT_S + 8 }].map((band, i) => (
          <g key={`hwy-${i}`}>
            <rect x="20" y={band.y1} width={FS_VB_W - 40} height={band.y2 - band.y1} fill="rgba(255,210,76,0.045)" rx="3"/>
            <line x1="20" y1={(band.y1 + band.y2) / 2} x2={FS_VB_W - 20} y2={(band.y1 + band.y2) / 2} stroke="rgba(255,210,76,0.18)" strokeWidth="1" strokeDasharray="4 6"/>
          </g>
        ))}

        <HighwayChevrons y={HW_TOP_N} dir="east" />
        <HighwayChevrons y={HW_TOP_S} dir="west" />
        <HighwayChevrons y={HW_BOT_N} dir="east" />
        <HighwayChevrons y={HW_BOT_S} dir="west" />

        {PACK_STATIONS_FS.map((p) => <PackStation key={p.id} p={p} count={packCountsRef.current[p.id]} />)}

        {AISLES_X.map((x, i) => (
          <g key={`gate-${x}`}>
            <circle cx={x} cy={HW_TOP_S} r="3.5" fill="#FFD24C" opacity="0.45"/>
            <circle cx={x} cy={HW_BOT_N} r="3.5" fill="#FFD24C" opacity="0.45"/>
            <text x={x} y={SHELF_TOP_Y - 8} textAnchor="middle" fontFamily="ui-monospace, Menlo, monospace" fontSize="9" fontWeight="700" fill="rgba(255,210,76,0.55)" letterSpacing="2">A{i+1}</text>
          </g>
        ))}

        {AISLES_X.map((x, i) => (
          <g key={`shelf-up-${i}`}>
            <ShelfBank x={x - SHELF_W - 8} y={SHELF_TOP_Y} w={SHELF_W} h={SHELF_TOP_H}/>
            <ShelfBank x={x + 8}            y={SHELF_TOP_Y} w={SHELF_W} h={SHELF_TOP_H}/>
          </g>
        ))}
        {AISLES_X.map((x, i) => (
          <g key={`shelf-lo-${i}`}>
            <ShelfBank x={x - SHELF_W - 8} y={SHELF_BOT_Y} w={SHELF_W} h={SHELF_BOT_H}/>
            <ShelfBank x={x + 8}            y={SHELF_BOT_Y} w={SHELF_W} h={SHELF_BOT_H}/>
          </g>
        ))}

        {robots.map((rb) => rb.state === "PICKING" && (
          <circle key={`pp-${rb.route.id}`} cx={rb.pos.x} cy={rb.pos.y} r="14" fill="none" stroke={rb.route.color} strokeWidth="2" opacity="0.8">
            <animate attributeName="r" values="10;26" dur="900ms" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.7;0" dur="900ms" repeatCount="indefinite"/>
          </circle>
        ))}

        {robots.map((rb) => <RobotTrail key={`tr-${rb.route.id}`} robot={rb} />)}
        {robots.map((rb) => <RobotSprite key={`bot-${rb.route.id}`} robot={rb} />)}

        <rect x="20" y={FLOOR_TOP - 10} width={FS_VB_W - 40} height={FLOOR_BOT - FLOOR_TOP + 20} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1"/>
        <g transform={`translate(36, ${FS_VB_H - 18})`}>
          <text fontFamily="ui-monospace, Menlo, monospace" fontSize="9" fontWeight="700" fill="rgba(255,255,255,0.45)" letterSpacing="2.5">FLEET FLOOR · LIVE SIM · 3 SONNYS COORDINATING</text>
        </g>
      </svg>
    </div>
  );
}

function HighwayChevrons({ y, dir }) {
  const xs = []; for (let x = 60; x < FS_VB_W - 60; x += 90) xs.push(x);
  const flip = dir === "west" ? -1 : 1;
  return (
    <g opacity="0.22">
      {xs.map((x) => (
        <path key={x} d={`M ${x - 3 * flip} ${y - 3} L ${x + 3 * flip} ${y} L ${x - 3 * flip} ${y + 3}`} fill="none" stroke="#FFD24C" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      ))}
    </g>
  );
}
function PackStation({ p, count }) {
  return (
    <g>
      <rect x={p.x - 60} y="46" width="120" height="36" rx="4" fill="#FFD24C"/>
      <rect x={p.x - 56} y="50" width="112" height="28" rx="2" fill="none" stroke="rgba(0,0,0,0.4)" strokeDasharray="3 3"/>
      <text x={p.x - 48} y="68" fontFamily="ui-monospace, Menlo, monospace" fontSize="10" fontWeight="700" fill="#202020" letterSpacing="2">{p.label}</text>
      <text x={p.x + 52} y="68" textAnchor="end" fontFamily="ui-monospace, Menlo, monospace" fontSize="11" fontWeight="700" fill="#202020">{String(count).padStart(2, "0")}</text>
      <line x1={p.x} y1="82" x2={p.x} y2={HW_TOP_N - 6} stroke="rgba(255,210,76,0.3)" strokeDasharray="2 3" strokeWidth="1"/>
      <g transform={`translate(${p.x}, 26)`}>
        <circle cx="0" cy="0" r="4.5" fill="#FFFFFF" opacity="0.7"/>
        <rect x="-3.5" y="4" width="7" height="9" rx="1" fill="#FFFFFF" opacity="0.7"/>
      </g>
    </g>
  );
}
function ShelfBank({ x, y, w, h }) {
  const slats = Math.max(2, Math.round(h / 38));
  const slatH = h / slats;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="rgba(232,228,214,0.78)" stroke="rgba(32,32,32,0.4)" strokeWidth="1" rx="1"/>
      {Array.from({ length: slats - 1 }).map((_, k) => (
        <line key={k} x1={x} y1={y + (k+1) * slatH} x2={x+w} y2={y + (k+1) * slatH} stroke="rgba(32,32,32,0.18)" strokeWidth="1"/>
      ))}
      {Array.from({ length: slats }).map((_, k) => (
        <rect key={`tag-${k}`} x={x + 4} y={y + k * slatH + slatH/2 - 2} width="14" height="3" rx="0.5" fill="rgba(32,32,32,0.35)"/>
      ))}
    </g>
  );
}
function RobotTrail({ robot }) {
  if (robot.trail.length < 2) return null;
  const pts = robot.trail;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;
  return <path d={d} fill="none" stroke={robot.route.color} strokeWidth="2.5" strokeOpacity="0.55" strokeLinecap="round" strokeLinejoin="round"/>;
}
function RobotSprite({ robot }) {
  const { pos, route, state } = robot;
  return (
    <g transform={`translate(${pos.x}, ${pos.y})`}>
      <rect x="-12" y="-18" width="24" height="6" rx="1.5" fill="#202020"/>
      <rect x="-10" y="-16" width="20" height="2.5" fill={route.color}/>
      <rect x="-15" y="-12" width="30" height="22" rx="6" fill={route.color} stroke="#0a0a0a" strokeWidth="1.5"/>
      <circle cx="0" cy="-1" r="3.5" fill="#FFFFFF"/>
      <circle cx="0" cy="-1" r="2" fill={route.color}>
        <animate attributeName="opacity" values="1;0.4;1" dur="1.6s" repeatCount="indefinite"/>
      </circle>
      <ellipse cx="-10" cy="11" rx="4" ry="2" fill="#0a0a0a"/>
      <ellipse cx="10"  cy="11" rx="4" ry="2" fill="#0a0a0a"/>
      <text x="0" y="22" textAnchor="middle" fontFamily="ui-monospace, Menlo, monospace" fontSize="8" fontWeight="700" fill="#FFFFFF" letterSpacing="1">{route.id}</text>
      {state === "YIELDING" && (
        <g>
          <circle cx="0" cy="-26" r="5" fill="#FF8A4C" opacity="0.9">
            <animate attributeName="opacity" values="0.9;0.3;0.9" dur="700ms" repeatCount="indefinite"/>
          </circle>
          <text x="0" y="-23" textAnchor="middle" fontFamily="ui-monospace, Menlo, monospace" fontSize="7" fontWeight="700" fill="#202020">!</text>
        </g>
      )}
    </g>
  );
}

/* ----- dispatcher panel ----- */
function FleetDispatcher() {
  const [, force] = React.useState(0);
  React.useEffect(() => {
    const unsub = FleetStore.subscribe(() => force((n) => n + 1));
    return unsub;
  }, []);
  const totalTotes = FleetStore.packs.P1 + FleetStore.packs.P2 + FleetStore.packs.P3;
  const robots = FleetStore.robots;
  return (
    <div className="fs-disp-panel">
      <div className="fs-disp-head">
        <div className="fs-disp-row-1">
          <span className="fs-disp-pulse"></span>
          <span className="fs-disp-title">FLEET · 3 ACTIVE</span>
        </div>
        <div className="fs-disp-cycle">CYCLE 04 · LIVE</div>
      </div>
      <div className="fs-disp-rows">
        {robots.map((rb) => (
          <div key={rb.id} className="fs-disp-row">
            <div className="fs-disp-row-head">
              <span className="fs-disp-id" style={{ color: rb.color }}>● {rb.id}</span>
              <span className={`fs-disp-state fs-disp-state-${rb.state.toLowerCase()}`}>{rb.state}</span>
            </div>
            <div className="fs-disp-row-body">
              <span className="fs-disp-loc">{rb.location}</span>
              <span className="fs-disp-totes">{rb.toteCount} totes</span>
            </div>
            <div className="fs-disp-bar">
              <div className="fs-disp-bar-fill" style={{ width: `${rb.progress * 100}%`, background: rb.color }}></div>
            </div>
          </div>
        ))}
      </div>
      <div className="fs-disp-foot">
        <div className="fs-disp-foot-row">
          <span className="fs-disp-foot-l">PACKED · TOTAL</span>
          <span className="fs-disp-foot-r" style={{ color: "#FFD24C" }}>{String(totalTotes).padStart(2, "0")}</span>
        </div>
        <div className="fs-disp-foot-rule"></div>
        <div className="fs-disp-foot-row sm"><span>P1</span><span>{FleetStore.packs.P1}</span></div>
        <div className="fs-disp-foot-row sm"><span>P2</span><span>{FleetStore.packs.P2}</span></div>
        <div className="fs-disp-foot-row sm"><span>P3</span><span>{FleetStore.packs.P3}</span></div>
        <div className="fs-disp-foot-rule"></div>
        <div className="fs-disp-foot-meta">COORDINATING · 0 COLLISIONS</div>
      </div>
    </div>
  );
}

/* ----- gripper glyphs ----- */
function ParallelJawGlyph() {
  return (
    <svg viewBox="0 0 360 240" xmlns="http://www.w3.org/2000/svg">
      <rect x="155" y="0" width="50" height="56" fill="#202020"/>
      <rect x="130" y="56" width="100" height="20" fill="#FFD24C" stroke="#202020" strokeWidth="2"/>
      <rect x="120" y="76" width="120" height="50" fill="#202020"/>
      <rect x="135" y="86" width="40" height="10" fill="#FFD24C" opacity="0.6"/>
      <rect x="185" y="86" width="40" height="10" fill="#FFD24C" opacity="0.6"/>
      <path d="M 130 126 L 130 200 L 150 200 L 150 126 Z" fill="#202020"/>
      <path d="M 210 126 L 210 200 L 230 200 L 230 126 Z" fill="#202020"/>
      <rect x="148" y="160" width="6" height="40" fill="#FFD24C"/>
      <rect x="206" y="160" width="6" height="40" fill="#FFD24C"/>
      <rect x="160" y="170" width="40" height="30" fill="#F9F6EC" stroke="#202020" strokeWidth="1.5"/>
      <line x1="170" y1="185" x2="190" y2="185" stroke="#202020" strokeWidth="1" opacity="0.4"/>
    </svg>
  );
}
function ComboGlyph() {
  const L = "#FFD24C";
  const LF = "rgba(255,210,76,0.55)";
  const LD = "rgba(255,210,76,0.25)";
  const TXT = "rgba(255,255,255,0.6)";
  const TXT_DIM = "rgba(255,255,255,0.4)";
  const D = "#202020";
  return (
    <svg viewBox="0 0 360 240" xmlns="http://www.w3.org/2000/svg">
      <rect x="155" y="0" width="50" height="28" fill={L}/>
      <rect x="115" y="28" width="130" height="14" fill="none" stroke={L} strokeWidth="2"/>
      <rect x="100" y="42" width="160" height="34" fill={L} opacity="0.92"/>
      <text x="135" y="64" fontFamily="ui-monospace, Menlo, monospace" fontSize="10" letterSpacing="0.22em" fill={D} textAnchor="middle" fontWeight="700">GRIPPER</text>
      <text x="225" y="64" fontFamily="ui-monospace, Menlo, monospace" fontSize="10" letterSpacing="0.22em" fill={D} textAnchor="middle" fontWeight="700">ONE HAND</text>
      <path d="M 110 76 L 110 168 L 130 168 L 130 76 Z" fill={L}/>
      <rect x="128" y="120" width="5" height="40" fill={D}/>
      <path d="M 230 76 L 230 168 L 250 168 L 250 76 Z" fill={L}/>
      <rect x="227" y="120" width="5" height="40" fill={D}/>
      <line x1="138" y1="180" x2="222" y2="180" stroke={LF} strokeWidth="1" strokeDasharray="2 3"/>
      <line x1="138" y1="176" x2="138" y2="184" stroke={LF} strokeWidth="1"/>
      <line x1="222" y1="176" x2="222" y2="184" stroke={LF} strokeWidth="1"/>
      <text x="180" y="194" fontFamily="ui-monospace, monospace" fontSize="9" letterSpacing="0.22em" fill={TXT} textAnchor="middle">JAW SPAN</text>
      <rect x="170" y="50" width="20" height="22" fill={D} opacity="0.6"/>
      <rect x="170" y="50" width="20" height="22" fill="none" stroke={D} strokeWidth="1" opacity="0.8"/>
      <rect x="172" y="76" width="16" height="20" fill={L}/>
      <rect x="174" y="96" width="12" height="20" fill={L} opacity="0.85"/>
      <rect x="176" y="116" width="8"  height="22" fill={L} opacity="0.7"/>
      <line x1="172" y1="96"  x2="188" y2="96"  stroke={D} strokeWidth="0.6" opacity="0.4"/>
      <line x1="174" y1="116" x2="186" y2="116" stroke={D} strokeWidth="0.6" opacity="0.4"/>
      <path d="M 172 138 L 172 142 Q 172 150 180 152 Q 188 150 188 142 L 188 138 Z" fill={L}/>
      <ellipse cx="180" cy="139" rx="8" ry="2.5" fill={D} opacity="0.5"/>
      <line x1="270" y1="60" x2="270" y2="148" stroke={LD} strokeWidth="1" strokeDasharray="3 3"/>
      <path d="M 266 144 L 270 152 L 274 144 Z" fill={LF}/>
      <text x="278" y="78" fontFamily="ui-monospace, monospace" fontSize="8" letterSpacing="0.22em" fill={TXT}>SUCTION</text>
      <text x="278" y="92" fontFamily="ui-monospace, monospace" fontSize="8" letterSpacing="0.22em" fill={TXT}>DEPLOYS</text>
      <text x="278" y="106" fontFamily="ui-monospace, monospace" fontSize="8" letterSpacing="0.22em" fill={TXT}>FROM</text>
      <text x="278" y="120" fontFamily="ui-monospace, monospace" fontSize="8" letterSpacing="0.22em" fill={TXT}>INSIDE</text>
      <rect x="172" y="158" width="16" height="8" fill="none" stroke={L} strokeWidth="1.2" opacity="0.6"/>
      <text x="180" y="218" fontFamily="ui-monospace, monospace" fontSize="9" letterSpacing="0.2em" fill={TXT} textAnchor="middle">ONE HAND · TWO MODES</text>
      <text x="180" y="230" fontFamily="ui-monospace, monospace" fontSize="8" letterSpacing="0.18em" fill={TXT_DIM} textAnchor="middle">jaws for boxes · suction for small items</text>
    </svg>
  );
}

/* ----- App: mounts the fleet sim where #fleet-mount lives, gripper glyphs where they're called ----- */
function FleetApp() {
  const [active, setActive] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    const el = document.getElementById('fleet-mount');
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(true); });
    }, { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div className="fleet-stage" ref={ref}>
      <div className="fleet-floor"><FleetScene active={active}/></div>
      <div className="fleet-rail"><FleetDispatcher /></div>
    </div>
  );
}

/* mount everywhere */
const fleetMount = document.getElementById('fleet-mount');
if (fleetMount) ReactDOM.createRoot(fleetMount).render(<FleetApp />);

const pjMount = document.getElementById('pj-glyph');
if (pjMount) ReactDOM.createRoot(pjMount).render(<ParallelJawGlyph />);

const comboMount = document.getElementById('combo-glyph');
if (comboMount) ReactDOM.createRoot(comboMount).render(<ComboGlyph />);
