import map from "../../data/india.json";

/**
 * Live equipment network map of India — an extruded, perspective-tilted
 * slab where every animation MEANS something:
 *   · booking "packets" travel from station hubs to the match core
 *   · sensor rings pulse where the network is listening
 *   · a radar sweep scans the country
 * Sensor/packet motion uses SVG-native SMIL animation, which keeps
 * running even when the OS "reduce motion" setting disables CSS
 * animations. No canvas, no rAF, no client JS.
 */

const ALERT_INDEX = 1; // Ludhiana — the demo high-demand zone
// stations that visibly stream packets (all 15 at once is noise)
const SENDERS = [0, 1, 4, 6, 8, 10, 13];

function arcPath(x1, y1, x2, y2) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const lift = Math.min(64, len * 0.22);
  const cx = mx - (dy / len) * lift;
  const cy = my + (dx / len) * lift;
  return `M${x1} ${y1}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2} ${y2}`;
}

export default function HeroMap({ caption }) {
  const { viewBox, path, stations, hub } = map;

  return (
    <div className="h-map" aria-hidden="true">
      <div className="ps-scene">
        <div className="ps-floor" />
        <div className="ps-plane">
          <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" fill="none">
            {/* extrusion — stacked dark copies give the slab depth */}
            <path d={path} transform="translate(7 22)" fill="#0e0903" opacity="0.85" />
            <path d={path} transform="translate(4.5 14)" fill="#161006" />
            <path d={path} transform="translate(2 7)" fill="#1f1709" />

            {/* top face */}
            <path
              d={path}
              fill="#2c2211"
              stroke="rgba(226, 206, 160, 0.55)"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />

            {/* faint data arcs: station → hub */}
            {stations.map((v, i) => (
              <path
                key={`arc-${v.name}`}
                d={arcPath(v.x, v.y, hub.x, hub.y)}
                stroke={
                  i === ALERT_INDEX
                    ? "rgba(224, 122, 74, 0.35)"
                    : "rgba(200, 214, 156, 0.16)"
                }
                strokeWidth="1"
                strokeDasharray="2 6"
              />
            ))}

            {/* booking packets streaming to the match core (SMIL —
                immune to the OS reduce-motion setting) */}
            {SENDERS.map((idx, k) => {
              const v = stations[idx];
              const alert = idx === ALERT_INDEX;
              const dur = alert ? 3.2 : 4.5 + (k % 3) * 0.7;
              const begin = `${(k * 1.35).toFixed(2)}s`;
              return (
                <circle
                  key={`pkt-${v.name}`}
                  r={alert ? 3 : 2.3}
                  fill={alert ? "#E07A4A" : "#F3C96B"}
                  opacity="0"
                >
                  <animateMotion
                    dur={`${dur}s`}
                    begin={begin}
                    repeatCount="indefinite"
                    path={arcPath(v.x, v.y, hub.x, hub.y)}
                  />
                  <animate
                    attributeName="opacity"
                    values="0;0.95;0.95;0"
                    keyTimes="0;0.08;0.85;1"
                    dur={`${dur}s`}
                    begin={begin}
                    repeatCount="indefinite"
                  />
                </circle>
              );
            })}

            {/* hub — AgriRent match core, pings when data arrives */}
            <circle cx={hub.x} cy={hub.y} r="10" fill="rgba(243,201,107,0.14)" />
            <circle cx={hub.x} cy={hub.y} r="4.5" fill="#F3C96B" />
            <circle cx={hub.x} cy={hub.y} r="5" stroke="#F3C96B" strokeWidth="1.4">
              <animate attributeName="r" values="5;16" dur="2.6s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.9;0" dur="2.6s" repeatCount="indefinite" />
            </circle>

            {/* station sensors — pulsing listening rings */}
            {stations.map((v, i) => {
              const alert = i === ALERT_INDEX;
              const c = alert ? "#E07A4A" : "#C8D69C";
              const begin = `${((i * 0.4) % 3.4).toFixed(2)}s`;
              return (
                <g key={v.name}>
                  <circle cx={v.x} cy={v.y} r={alert ? 4.4 : 3.2} fill={c} />
                  <circle cx={v.x} cy={v.y} r="4" stroke={c} strokeWidth="1.2">
                    <animate
                      attributeName="r"
                      values={alert ? "4;15" : "4;11"}
                      dur="3.4s"
                      begin={begin}
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.8;0"
                      dur="3.4s"
                      begin={begin}
                      repeatCount="indefinite"
                    />
                  </circle>
                </g>
              );
            })}
          </svg>
          <div className="ps-sweep" />
        </div>
      </div>
      {caption ? <span className="h-cap">{caption}</span> : null}
    </div>
  );
}
