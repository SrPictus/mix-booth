// Mix Booth: una cabina de DJ para las listas mezcladas de Spotify. Dos platos que giran a su BPM,
// una mesa cuyos mandos siguen las curvas reales de la mezcla y un editor para cambiar cada transición
(function mixBooth() {
  const P = Spicetify?.Platform;
  if (!Spicetify?.Player?.data || !P?.PlaylistMixingAPI || !P?.PlaylistAPI || !Spicetify.Playbar?.Button || !Spicetify.ContextMenu) {
    setTimeout(mixBooth, 300);
    return;
  }
  const api = P.PlaylistMixingAPI;
  const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Datos de la mezcla ----------

  // Las curvas de Spotify: tramos con inicio y final en fracción de la mezcla y puntos {x, y} dentro de cada tramo
  function curveAt(curve, t) {
    const parts = curve?.curves;
    if (!parts?.length) return null;
    const part = parts.find((p) => t >= p.start && t < p.end) ?? (t < parts[0].start ? parts[0] : parts[parts.length - 1]);
    const points = part.points ?? [];
    if (!points.length) return null;
    const x = part.end > part.start ? Math.min(1, Math.max(0, (t - part.start) / (part.end - part.start))) : 1;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (x <= b.x) return b.x > a.x ? a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x) : b.y;
    }
    return points[points.length - 1].y;
  }

  // Cada tipo de estilo: dónde se pide, cómo se llama la lista y qué curvas tiene
  const KINDS = {
    volume: { label: "Volume", method: "getVolumeStylesForVolumeStyleIds", list: "volumeStyles", key: "volumeStyleOverride", curves: ["fadeOutCurves", "fadeInCurves"] },
    eq: { label: "EQ", method: "getEqStylesForEqStyleIds", list: "eqStyles", key: "eqStyleOverride", curves: ["lowEqOutCurves", "lowEqInCurves"] },
    filter: { label: "Filter", method: "getFilterFxStylesForFilterFxStyleIds", list: "filterFxStyles", key: "filterFxStyleOverride", curves: ["filterCutoffOutCurves", "filterCutoffInCurves"] },
    fx: { label: "Echo & reverb", method: "getFxStylesForFxStyleIds", list: "fxStyles", key: "fxStyleOverride", curves: ["reverbDryWetOutCurves", "echoDryWetOutCurves"] },
    loop: { label: "Loop", method: "getLoopingBlocksForLoopingStyleIds", list: "loopingStyleBlocks", key: "loopingStyleOverride", curves: [] },
  };
  const MAX_STYLE_ID = 24;
  const styleCache = new Map();

  // Todos los estilos que existen de un tipo: se piden de una vez los números posibles y se quedan los que tienen algo
  async function stylesOf(kind) {
    if (styleCache.has(kind)) return styleCache.get(kind);
    const info = KINDS[kind];
    const ids = Array.from({ length: MAX_STYLE_ID }, (_, i) => i + 1);
    let found = [];
    try {
      const result = await api[info.method](ids);
      found = (result?.[info.list] ?? []).filter((entry) => {
        if (kind === "loop") return entry.out?.blocks?.length;
        return Object.keys(entry).some((name) => name !== "style" && entry[name]?.curves?.length);
      });
    } catch {}
    found.sort((a, b) => a.style.id - b.style.id);
    styleCache.set(kind, found);
    return found;
  }

  async function styleById(kind, id) {
    if (!id) return null;
    return (await stylesOf(kind)).find((entry) => entry.style.id === id) ?? null;
  }

  // Las curvas que suenan de verdad: las propias de la transición mandan sobre las de su estilo
  async function effectsOf(preset) {
    const [volume, eq, filter, fx] = await Promise.all([
      styleById("volume", preset?.volumeStyleOverride?.id),
      styleById("eq", preset?.eqStyleOverride?.id),
      styleById("filter", preset?.filterFxStyleOverride?.id),
      styleById("fx", preset?.fxStyleOverride?.id),
    ]);
    const pick = (own, fromStyle) => (own?.curves?.length ? own : fromStyle?.curves?.length ? fromStyle : null);
    const side = (dir) => ({
      volume: pick(preset?.[`volume${dir}CurveOverride`], volume?.[`fade${dir}Curves`]),
      low: pick(preset?.[`eq${dir}CurveOverrides`]?.low, eq?.[`lowEq${dir}Curves`]),
      mid: pick(preset?.[`eq${dir}CurveOverrides`]?.mid, eq?.[`midEq${dir}Curves`]),
      high: pick(preset?.[`eq${dir}CurveOverrides`]?.high, eq?.[`highEq${dir}Curves`]),
      cutoff: pick(preset?.[`filter${dir}CurveOverrides`]?.cutoff, filter?.[`filterCutoff${dir}Curves`]),
      reverb: pick(preset?.[`fx${dir}CurveOverrides`]?.reverbDryWet, fx?.[`reverbDryWet${dir}Curves`]),
      echo: pick(preset?.[`fx${dir}CurveOverrides`]?.echoDryWet, fx?.[`echoDryWet${dir}Curves`]),
    });
    return { out: side("Out"), in: side("In") };
  }

  const coverOf = (meta) => {
    const image = meta?.image_xlarge_url ?? meta?.image_large_url ?? meta?.image_url ?? meta?.image_small_url;
    return image?.startsWith("spotify:image:") ? `https://i.scdn.co/image/${image.split(":").pop()}` : image ?? null;
  };

  const trackInfo = (item) => item?.uri ? {
    uri: item.uri,
    name: item.name ?? item.metadata?.title ?? "",
    artist: item.artists?.map((a) => a.name).join(", ") ?? item.metadata?.artist_name ?? "",
    cover: coverOf(item.metadata) ?? item.images?.[0]?.url ?? null,
    length: item.duration?.milliseconds ?? Number(item.metadata?.duration) ?? 0,
  } : null;

  // ---------- Estilos ----------

  const style = document.createElement("style");
  style.textContent = `
    .mb-booth {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 18px;
      padding: 28px 36px 30px;
      color: #fff;
      font-family: var(--encore-body-font-stack, sans-serif);
      background: #07080d;
      overflow: hidden;
      animation: mb-in 0.35s ease;
    }
    @keyframes mb-in { from { opacity: 0; transform: scale(1.02); } }
    .mb-backdrop {
      position: absolute;
      inset: -60px;
      z-index: -1;
      background-size: cover;
      background-position: center;
      filter: blur(60px) saturate(1.6) brightness(0.35);
      animation: mb-drift 38s ease-in-out infinite alternate;
    }
    /* La segunda capa es la canción que entra: aparece según avanza el crossfader */
    .mb-backdrop-b { opacity: var(--o, 0); transition: opacity 0.4s ease; animation-delay: -19s; }
    @keyframes mb-drift {
      from { transform: scale(1.05) rotate(0deg); }
      to { transform: scale(1.25) rotate(6deg) translate(2%, -2%); }
    }
    /* Cuenta atrás de los últimos diez segundos antes de la mezcla */
    .mb-count {
      position: absolute;
      left: 50%;
      top: 9%;
      z-index: 1;
      font-family: var(--encore-title-font-stack, inherit);
      font-size: clamp(64px, 12vh, 130px);
      font-weight: 900;
      line-height: 1;
      color: #fff;
      text-shadow: 0 0 40px rgba(255, 77, 140, 0.8);
      opacity: 0;
      transform: translateX(-50%);
      pointer-events: none;
    }
    .mb-count.is-on { animation: mb-count 1s ease-out forwards; }
    @keyframes mb-count {
      from { opacity: 0.95; transform: translateX(-50%) scale(1.4); }
      to { opacity: 0; transform: translateX(-50%) scale(1); }
    }
    .mb-top { display: flex; align-items: center; gap: 14px; }
    .mb-top h1 {
      flex: 1;
      margin: 0;
      font-family: var(--encore-title-font-stack, inherit);
      font-size: 22px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    .mb-status { font-size: 13px; opacity: 0.7; letter-spacing: 0.08em; text-transform: uppercase; }
    .mb-status.is-live { color: #ff4d6d; opacity: 1; }
    .mb-status.is-live::before { content: "●  "; }
    .mb-btn {
      padding: 9px 18px;
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      color: #fff;
      font: inherit;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .mb-btn:hover { background: rgba(255,255,255,0.18); }
    .mb-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .mb-btn[disabled] { opacity: 0.4; cursor: default; }
    .mb-btn.is-primary { background: #fff; color: #000; border-color: #fff; }
    .mb-stage {
      display: grid;
      grid-template-columns: 1fr minmax(260px, 340px) 1fr;
      align-items: center;
      gap: 28px;
      min-height: 0;
    }
    .mb-deck { display: flex; flex-direction: column; align-items: center; gap: 16px; min-width: 0; transition: opacity 0.6s ease; }
    .mb-deck.is-idle { opacity: 0.45; }
    .mb-platter {
      position: relative;
      width: min(34vh, 26vw);
      aspect-ratio: 1;
    }
    /* Anillo de luz que late en cada beat: cian la canción que sale, rosa la que entra */
    .mb-ring {
      position: absolute;
      inset: -14px;
      border-radius: 50%;
      border: 2px solid rgba(var(--glow), calc(0.12 + var(--beat, 0) * 0.6));
      box-shadow: 0 0 calc(8px + var(--beat, 0) * 56px) rgba(var(--glow), calc(var(--beat, 0) * 0.55));
      pointer-events: none;
    }
    .mb-deck-a { --glow: 109, 240, 255; }
    .mb-deck-b { --glow: 255, 77, 140; }
    /* El brazo: baja sobre el disco cuando suena y vuelve a su sitio cuando para */
    .mb-arm {
      position: absolute;
      top: -6%;
      right: -4%;
      width: 10px;
      height: 50%;
      border-radius: 5px;
      background: linear-gradient(90deg, #6a6a6a, #e4e4e4 50%, #7a7a7a);
      box-shadow: 0 8px 18px rgba(0,0,0,0.55);
      transform-origin: 50% 6px;
      transform: rotate(var(--arm, 4deg));
      transition: transform 0.9s cubic-bezier(.22,1,.36,1);
      pointer-events: none;
    }
    .mb-arm::before {
      content: "";
      position: absolute;
      top: -14px;
      left: 50%;
      width: 34px;
      height: 34px;
      margin-left: -17px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #bdbdbd, #2b2b2b);
      box-shadow: 0 4px 12px rgba(0,0,0,0.6);
    }
    .mb-arm::after {
      content: "";
      position: absolute;
      bottom: -18px;
      left: 50%;
      width: 18px;
      height: 28px;
      margin-left: -9px;
      border-radius: 4px;
      background: linear-gradient(#d6d6d6, #5c5c5c);
    }
    .mb-platter.is-current .mb-vinyl { cursor: grab; }
    .mb-platter.is-scratch .mb-vinyl { cursor: grabbing; }
    .mb-vinyl {
      position: relative;
      width: 100%;
      aspect-ratio: 1;
      touch-action: none;
      border-radius: 50%;
      background:
        radial-gradient(circle, transparent 31%, rgba(255,255,255,0.05) 31.5%, transparent 33%),
        repeating-radial-gradient(circle, #111 0 2px, #1b1b1b 2px 3px);
      box-shadow: 0 30px 80px rgba(0,0,0,0.6), inset 0 0 0 6px #0a0a0a;
    }
    .mb-vinyl::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: linear-gradient(130deg, rgba(255,255,255,0.12), transparent 40%, transparent 60%, rgba(255,255,255,0.06));
      pointer-events: none;
    }
    /* Marcas de estroboscopio en el borde: así se nota que gira */
    .mb-vinyl::before {
      content: "";
      position: absolute;
      inset: 2.5%;
      border-radius: 50%;
      background: repeating-conic-gradient(rgba(255,255,255,0.4) 0 1.4deg, transparent 1.4deg 7.5deg);
      -webkit-mask-image: radial-gradient(circle, transparent 65%, #000 65.5%, #000 68%, transparent 68.5%);
      mask-image: radial-gradient(circle, transparent 65%, #000 65.5%, #000 68%, transparent 68.5%);
      pointer-events: none;
    }
    .mb-label {
      position: absolute;
      inset: 30%;
      border-radius: 50%;
      background-size: cover;
      background-position: center;
      box-shadow: 0 0 0 3px #0a0a0a, 0 0 calc(var(--beat, 0) * 30px) rgba(var(--glow), calc(var(--beat, 0) * 0.5));
      scale: calc(1 + var(--beat, 0) * 0.035);
    }
    .mb-label::after {
      content: "";
      position: absolute;
      inset: 46%;
      border-radius: 50%;
      background: #07080d;
    }
    .mb-meta { width: 100%; text-align: center; }
    .mb-meta b, .mb-meta span { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .mb-meta b { font-size: 20px; }
    .mb-meta span { font-size: 14px; opacity: 0.7; }
    .mb-meta small { display: block; margin-top: 6px; font-size: 12px; letter-spacing: 0.1em; opacity: 0.6; }
    .mb-mixer {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px 22px;
      padding: 22px;
      border-radius: 22px;
      background: rgba(0,0,0,0.4);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .mb-channel { display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .mb-knob { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 10px; letter-spacing: 0.12em; opacity: 0.85; }
    .mb-knob i {
      position: relative;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #3a3a3a, #121212);
      box-shadow: 0 2px 6px rgba(0,0,0,0.6), inset 0 0 0 2px rgba(255,255,255,0.08);
    }
    .mb-knob i::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 4px;
      width: 3px;
      height: 12px;
      margin-left: -1.5px;
      border-radius: 2px;
      background: #fff;
      transform-origin: 50% 15px;
      transform: rotate(var(--a, 0deg));
    }
    .mb-knob.is-cut i::after { background: #ff4d6d; }
    .mb-knob.is-boost i::after { background: #6df0ff; }
    .mb-meter { position: relative; width: 8px; height: 90px; border-radius: 4px; background: rgba(255,255,255,0.1); overflow: hidden; }
    .mb-meter b { position: absolute; left: 0; right: 0; bottom: 0; height: var(--v, 0%); background: linear-gradient(0deg, #4dff9a, #ffe14d 70%, #ff4d6d); background-size: 100% 90px; background-position: bottom; }
    .mb-meter u { position: absolute; left: 0; right: 0; bottom: var(--p, 0%); height: 2px; background: #fff; opacity: 0.85; }
    .mb-xfader { grid-column: 1 / -1; position: relative; height: 26px; margin-top: 6px; }
    .mb-xfader::before { content: ""; position: absolute; left: 0; right: 0; top: 12px; height: 3px; border-radius: 3px; background: rgba(255,255,255,0.25); }
    .mb-xfader i {
      position: absolute;
      top: 2px;
      left: var(--x, 0%);
      width: 18px;
      height: 22px;
      margin-left: -9px;
      border-radius: 4px;
      background: linear-gradient(#eee, #999);
      box-shadow: 0 2px 8px rgba(0,0,0,0.6);
    }
    .mb-fxrow { grid-column: 1 / -1; display: flex; justify-content: space-between; font-size: 11px; letter-spacing: 0.08em; opacity: 0.75; }
    .mb-scrub { position: relative; }
    .mb-timeline { position: relative; height: 64px; border-radius: 12px; background: rgba(0,0,0,0.35); overflow: hidden; cursor: pointer; touch-action: none; }
    .mb-timeline:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
    .mb-timeline canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .mb-scrub:hover .mb-head, .mb-scrub.is-drag .mb-head { width: 3px; }
    .mb-tip {
      position: absolute;
      bottom: calc(100% + 8px);
      left: 0;
      padding: 4px 9px;
      border-radius: 6px;
      background: #fff;
      color: #000;
      font-size: 12px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      opacity: 0;
      transform: translateX(-50%);
      pointer-events: none;
      transition: opacity 0.15s ease;
    }
    .mb-scrub:hover .mb-tip, .mb-scrub.is-drag .mb-tip { opacity: 1; }
    .mb-timeline .mb-mix { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(90deg, rgba(255,77,109,0.35) 0 2px, transparent 2px 8px); border-left: 2px solid #ff4d6d; }
    .mb-timeline .mb-played { position: absolute; top: 0; bottom: 0; left: 0; background: rgba(255,255,255,0.12); }
    .mb-timeline .mb-head { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; box-shadow: 0 0 10px #fff; }
    .mb-timeline span { position: absolute; left: 10px; top: 50%; padding: 4px 9px; border-radius: 6px; background: rgba(0,0,0,0.7); transform: translateY(-50%); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 0.06em; pointer-events: none; }

    .mb-editor {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 28px 36px;
      overflow: auto;
      background: rgba(7,8,13,0.94);
      animation: mb-in 0.25s ease;
    }
    .mb-editor h2 { margin: 0; font-size: 18px; }
    .mb-editor h2 small { display: block; margin-top: 4px; font-size: 13px; font-weight: 400; opacity: 0.7; }
    .mb-group h3 { margin: 0 0 8px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.7; }
    .mb-cards { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; }
    .mb-card {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border: 2px solid transparent;
      border-radius: 12px;
      background: rgba(255,255,255,0.06);
      color: #fff;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .mb-card:hover { background: rgba(255,255,255,0.12); }
    .mb-card:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .mb-card.is-on { border-color: #fff; background: rgba(255,255,255,0.16); }
    .mb-card svg { display: block; width: 96px; height: 40px; }
    .mb-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .mb-row label { min-width: 150px; font-size: 13px; opacity: 0.8; }
    .mb-row output { min-width: 70px; font-variant-numeric: tabular-nums; font-size: 13px; text-align: center; }
    .mb-note { font-size: 12px; opacity: 0.65; }
    @media (prefers-reduced-motion: reduce) {
      .mb-booth, .mb-editor, .mb-backdrop, .mb-count.is-on { animation: none; }
      .mb-arm { transition: none; }
    }
  `;
  document.head.append(style);

  // ---------- Construcción ----------

  const el = (tag, className, parent) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    parent?.append(node);
    return node;
  };

  function buildDeck(parent, side) {
    const deck = el("div", `mb-deck mb-deck-${side}`, parent);
    // El plato no gira: lleva el anillo de luz y el brazo. Encima gira el disco
    const platter = el("div", "mb-platter", deck);
    el("div", "mb-ring", platter);
    const vinyl = el("div", "mb-vinyl", platter);
    const label = el("div", "mb-label", vinyl);
    el("div", "mb-arm", platter);
    const meta = el("div", "mb-meta", deck);
    const name = el("b", "", meta);
    const artist = el("span", "", meta);
    const info = el("small", "", meta);
    const result = { deck, platter, vinyl, label, name, artist, info, angle: 0, scratch: null, isCurrent: false };
    enableScratch(result);
    return result;
  }

  // Scratch: arrastrar el disco de la canción que suena la mueve hacia delante o hacia atrás. Una vuelta es un compás
  function enableScratch(deck) {
    const angleOf = (event) => {
      const box = deck.vinyl.getBoundingClientRect();
      return (Math.atan2(event.clientY - (box.top + box.height / 2), event.clientX - (box.left + box.width / 2)) * 180) / Math.PI;
    };
    deck.vinyl.addEventListener("pointerdown", (event) => {
      if (!deck.isCurrent || event.button !== 0) return;
      event.preventDefault();
      deck.vinyl.setPointerCapture(event.pointerId);
      deck.scratch = { last: angleOf(event), total: 0 };
      deck.platter.classList.add("is-scratch");
    });
    deck.vinyl.addEventListener("pointermove", (event) => {
      if (!deck.scratch) return;
      const now = angleOf(event);
      let delta = now - deck.scratch.last;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      deck.scratch.last = now;
      deck.scratch.total += delta;
      deck.angle += delta;
      deck.vinyl.style.transform = `rotate(${deck.angle.toFixed(1)}deg)`;
    });
    const release = () => {
      if (!deck.scratch) return;
      const offset = (deck.scratch.total / 360) * deck.barMs;
      deck.scratch = null;
      deck.platter.classList.remove("is-scratch");
      if (Math.abs(offset) > 150) seekTo(Spicetify.Player.getProgress() + offset);
    };
    deck.vinyl.addEventListener("pointerup", release);
    deck.vinyl.addEventListener("pointercancel", release);
  }

  function seekTo(ms) {
    const length = Spicetify.Player.data?.item?.duration?.milliseconds ?? Spicetify.Player.getDuration();
    const target = Math.round(Math.min(Math.max(0, ms), Math.max(0, length - 1000)));
    Promise.resolve(P.PlayerAPI?.seekTo ? P.PlayerAPI.seekTo(target) : Spicetify.Player.seek(target)).catch(() => {});
  }

  // ---------- Análisis de audio ----------
  // Los beats y el volumen de cada momento de la canción, si Spotify los da. Sin ellos se usa el BPM
  const analysisCache = new Map();

  function analysisOf(uri) {
    if (!uri || typeof Spicetify.getAudioData !== "function") return null;
    if (!analysisCache.has(uri)) {
      analysisCache.set(uri, null);
      if (analysisCache.size > 8) analysisCache.delete(analysisCache.keys().next().value);
      Promise.resolve(Spicetify.getAudioData(uri)).then((data) => {
        if (!data?.segments?.length && !data?.beats?.length) return;
        analysisCache.set(uri, {
          beats: (data.beats ?? []).map((beat) => beat.start * 1000),
          segments: (data.segments ?? []).map((segment) => ({ at: segment.start * 1000, loud: segment.loudness_max })),
        });
      }).catch(() => {});
    }
    return analysisCache.get(uri);
  }

  const lastAtOrBefore = (list, value, read = (x) => x) => {
    let low = 0, high = list.length - 1, found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (read(list[mid]) <= value) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  };

  function beatPhase(analysis, position, bpm, anchor) {
    const beats = analysis?.beats;
    if (beats?.length > 4) {
      const i = lastAtOrBefore(beats, position);
      if (i >= 0 && i < beats.length - 1) return (position - beats[i]) / (beats[i + 1] - beats[i]);
    }
    const beatMs = 60000 / (bpm || 120);
    return ((((position - anchor) % beatMs) + beatMs) % beatMs) / beatMs;
  }

  // De decibelios a un nivel de 0 a 1 para los medidores
  const levelOf = (loud) => Math.min(1, Math.max(0, (loud + 40) / 40));

  function loudnessAt(analysis, position) {
    const segments = analysis?.segments;
    if (!segments?.length) return null;
    const i = lastAtOrBefore(segments, position, (segment) => segment.at);
    return i < 0 ? null : levelOf(segments[i].loud);
  }

  function buildKnob(parent, text) {
    const knob = el("div", "mb-knob", parent);
    const dial = el("i", "", knob);
    el("span", "", knob).textContent = text;
    return { knob, dial };
  }

  function buildChannel(parent) {
    const channel = el("div", "mb-channel", parent);
    const knobs = { high: buildKnob(channel, "HIGH"), mid: buildKnob(channel, "MID"), low: buildKnob(channel, "LOW"), cutoff: buildKnob(channel, "FILTER") };
    const meter = el("div", "mb-meter", channel);
    const level = el("b", "", meter);
    const peakMark = el("u", "", meter);
    return { knobs, level, peakMark, peak: 0 };
  }

  let booth = null;
  let frame = 0;

  function openBooth() {
    if (booth) return;
    const root = el("div", "mb-booth", document.body);
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Mix Booth");
    const backdrop = el("div", "mb-backdrop", root);
    const backdropB = el("div", "mb-backdrop mb-backdrop-b", root);
    const count = el("div", "mb-count", root);
    count.setAttribute("aria-hidden", "true");
    const top = el("div", "mb-top", root);
    el("h1", "", top).textContent = "Mix Booth";
    const status = el("span", "mb-status", top);
    const edit = el("button", "mb-btn", top);
    edit.textContent = "Edit transition";
    const close = el("button", "mb-btn", top);
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close Mix Booth");

    const stage = el("div", "mb-stage", root);
    const deckA = buildDeck(stage, "a");
    const mixer = el("div", "mb-mixer", stage);
    const deckB = buildDeck(stage, "b");
    const channelA = buildChannel(mixer);
    const channelB = buildChannel(mixer);
    const xfader = el("div", "mb-xfader", mixer);
    const knob = el("i", "", xfader);
    const fxRow = el("div", "mb-fxrow", mixer);
    const fxA = el("span", "", fxRow);
    const fxB = el("span", "", fxRow);

    // La barra de la canción que suena: su onda, la zona de la mezcla, y se puede tocar para moverse
    const scrub = el("div", "mb-scrub", root);
    const timeline = el("div", "mb-timeline", scrub);
    timeline.tabIndex = 0;
    timeline.setAttribute("role", "slider");
    timeline.setAttribute("aria-label", "Song position");
    timeline.setAttribute("aria-valuemin", "0");
    const wave = el("canvas", "", timeline);
    const played = el("div", "mb-played", timeline);
    const mixZone = el("div", "mb-mix", timeline);
    const head = el("div", "mb-head", timeline);
    const timeText = el("span", "", timeline);
    const tip = el("div", "mb-tip", scrub);
    tip.setAttribute("aria-hidden", "true");

    booth = { root, backdrop, backdropB, count, status, edit, deckA, deckB, channelA, channelB, knob, fxA, fxB, timeline, wave, played, mixZone, head, timeText, tip, drag: null, waveKey: null, lastCount: null, last: performance.now() };

    const msAt = (event) => {
      const box = timeline.getBoundingClientRect();
      return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * (booth.timelineLength || 0);
    };
    const showTip = (event, ms) => {
      const box = timeline.getBoundingClientRect();
      booth.tip.style.left = `${Math.min(box.width, Math.max(0, event.clientX - box.left))}px`;
      setText(booth.tip, time(ms));
    };
    timeline.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      timeline.setPointerCapture(event.pointerId);
      booth.drag = msAt(event);
      timeline.parentElement.classList.add("is-drag");
      showTip(event, booth.drag);
    });
    timeline.addEventListener("pointermove", (event) => {
      const ms = msAt(event);
      if (booth.drag !== null) booth.drag = ms;
      showTip(event, ms);
    });
    const endDrag = () => {
      if (booth?.drag === null || !booth) return;
      seekTo(booth.drag);
      // La barra se queda donde la soltaste hasta que Spotify confirme la nueva posición
      booth.dragUntil = performance.now() + 700;
      booth.dragHold = booth.drag;
      booth.drag = null;
      timeline.parentElement.classList.remove("is-drag");
    };
    timeline.addEventListener("pointerup", endDrag);
    timeline.addEventListener("pointercancel", endDrag);
    timeline.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 15000 : 5000;
      if (event.key === "ArrowRight") seekTo(Spicetify.Player.getProgress() + step);
      else if (event.key === "ArrowLeft") seekTo(Spicetify.Player.getProgress() - step);
      else return;
      event.preventDefault();
    });
    close.addEventListener("click", closeBooth);
    edit.addEventListener("click", () => {
      const { a, b, context } = booth.state ?? {};
      if (a && b && context) openEditor({ contextUri: context, aUri: a.uri, bUri: b.uri });
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") (booth?.editor ? closeEditor() : closeBooth());
    });
    close.focus();
    frame = requestAnimationFrame(tick);
  }

  function closeBooth() {
    if (!booth) return;
    cancelAnimationFrame(frame);
    booth.root.remove();
    booth = null;
    boothButton.active = false;
  }

  // ---------- Qué suena ----------

  // Una mezcla por pareja de canciones: la que acaba de pasar y la que viene
  const plans = new Map();
  let previous = null;

  function getPlan(context, aUri, bUri) {
    const key = `${context}|${aUri}|${bUri}`;
    if (!plans.has(key)) {
      plans.set(key, { key, ready: false });
      if (plans.size > 6) plans.delete(plans.keys().next().value);
      loadPlan(plans.get(key), context, aUri, bUri);
    }
    return plans.get(key);
  }

  // Cuándo cambió la canción y en qué punto entró la nueva: en una mezcla de verdad entra justo donde
  // empieza su parte de la mezcla. Si la pusiste a mano, empieza en otro sitio aunque Spotify tenga una mezcla guardada
  let change = null;
  const MIX_ENTRY_TOLERANCE_MS = 4000;

  Spicetify.Player.addEventListener("songchange", () => {
    previous = current;
    current = trackInfo(Spicetify.Player.data?.item);
    change = { at: performance.now(), entry: null };
  });
  let current = trackInfo(Spicetify.Player.data?.item);

  // La mezcla entre dos canciones se pide una vez y se guarda con sus curvas
  async function loadPlan(mine, context, aUri, bUri) {
    try {
      const transition = await api.getComposedTransitionForTrackPair(context, aUri, bUri);
      const overlap = transition?.overlap;
      const [effects, blocks] = await Promise.all([effectsOf(transition?.preset), loopBlocksOf(transition?.preset)]);
      Object.assign(mine, { ready: true, transition, overlap: overlap?.durationMs > 0 ? overlap : null, effects, blocks });
    } catch {
      Object.assign(mine, { ready: true, overlap: null });
    }
  }

  async function loopBlocksOf(preset) {
    const custom = preset?.loopingOutBlocksOverride?.blocks;
    if (Array.isArray(custom) && custom.length) return custom;
    return (await styleById("loop", preset?.loopingStyleOverride?.id))?.out?.blocks ?? [];
  }

  // Dos casos: la canción va hacia su mezcla (A suena, B espera) o la mezcla ya empezó (B suena, A se apaga)
  function readState() {
    const data = Spicetify.Player.data;
    const context = data?.context?.uri ?? "";
    const isPlaylist = context.startsWith("spotify:playlist:");
    const position = Spicetify.Player.getProgress();
    const nextItem = Spicetify.Queue?.nextTracks?.[0]?.contextTrack;
    const next = nextItem?.uri?.startsWith("spotify:track:") ? trackInfo({ uri: nextItem.uri, metadata: nextItem.metadata, name: nextItem.metadata?.title }) : null;
    // Recién cambiada de canción puede que estemos dentro de la mezcla con la anterior
    // La primera lectura tras el cambio dice en qué punto entró la canción
    // Se espera un momento: justo al cambiar, Spotify aún puede dar la posición de la canción anterior
    const sinceChange = change ? performance.now() - change.at : 0;
    if (change && change.entry === null && sinceChange > 400) change.entry = position - sinceChange;
    if (isPlaylist && previous && current && previous.uri !== current.uri && change && position < 90000) {
      const behind = getPlan(context, previous.uri, current.uri);
      const elapsed = behind.overlap ? position - behind.overlap.startBMs : -1;
      const enteredAtMix = behind.overlap && Math.abs(change.entry - behind.overlap.startBMs) < MIX_ENTRY_TOLERANCE_MS;
      if (behind.ready && enteredAtMix && elapsed >= 0 && elapsed < behind.overlap.durationMs) {
        return { context, a: previous, b: current, mixing: true, elapsed, position, plan: behind };
      }
    }
    const ahead = isPlaylist && current && next ? getPlan(context, current.uri, next.uri) : null;
    const usable = ahead?.ready && ahead.overlap ? ahead : null;
    return { context: isPlaylist ? context : null, a: current, b: next, mixing: false, elapsed: usable ? position - usable.overlap.startAMs : null, position, plan: usable };
  }

  // ---------- Pintar ----------

  const setVar = (node, name, value) => {
    if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
  };
  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };
  const time = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function paintKnob({ knob, dial }, value) {
    // 0,5 es neutro: el mando apunta arriba. 0 corta del todo, 1 sube al máximo
    const v = value ?? 0.5;
    setVar(dial, "--a", `${Math.round((v - 0.5) * 270)}deg`);
    knob.classList.toggle("is-cut", v < 0.45);
    knob.classList.toggle("is-boost", v > 0.55);
  }

  // El medidor: el volumen de la mezcla por lo fuerte que suena ese momento de la canción, con su pico marcado
  function paintChannel(channel, side, t, level, dt) {
    for (const band of ["high", "mid", "low", "cutoff"]) paintKnob(channel.knobs[band], t === null ? 0.5 : curveAt(side?.[band], t));
    channel.peak = Math.max(level, channel.peak - dt * 0.0005);
    setVar(channel.level, "--v", `${Math.round(level * 100)}%`);
    setVar(channel.peakMark, "--p", `${Math.round(channel.peak * 100)}%`);
  }

  function paintDeck(deck, track, bpm, spinning, dt, extra, phase, isCurrent) {
    deck.deck.classList.toggle("is-idle", !spinning);
    deck.isCurrent = isCurrent;
    deck.platter.classList.toggle("is-current", isCurrent);
    deck.barMs = (4 * 60000) / (bpm || 120);
    setText(deck.name, track?.name ?? "—");
    setText(deck.artist, track?.artist ?? "");
    const scratching = deck.scratch ? `${deck.scratch.total >= 0 ? "+" : "−"}${(Math.abs(deck.scratch.total / 360) * deck.barMs / 1000).toFixed(1)}s` : "";
    setText(deck.info, scratching || [bpm ? `${Math.round(bpm)} BPM` : "", extra].filter(Boolean).join("  ·  "));
    const image = track?.cover ? `url("${track.cover}")` : "none";
    if (deck.label.style.backgroundImage !== image) deck.label.style.backgroundImage = image;
    // El brazo baja sobre el disco mientras suena
    setVar(deck.platter, "--arm", spinning ? "24deg" : "4deg");
    // Un golpe de luz en cada beat que se apaga hasta el siguiente
    const beat = spinning && !REDUCED_MOTION ? Math.pow(1 - phase, 3) : 0;
    setVar(deck.platter, "--beat", beat.toFixed(2));
    // Una vuelta por compás de cuatro tiempos
    if (spinning && !REDUCED_MOTION && !deck.scratch) {
      deck.angle = (deck.angle + (dt / 1000) * (360 / ((4 * 60) / (bpm || 120)))) % 360;
      deck.vinyl.style.transform = `rotate(${deck.angle.toFixed(1)}deg)`;
    }
  }

  // La onda de la canción, dibujada una vez por canción y tamaño
  function drawWave(analysis, length) {
    const canvas = booth.wave;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const key = `${booth.timelineUri}|${width}|${!!analysis}`;
    if (key === booth.waveKey || !width) return;
    booth.waveKey = key;
    const ratio = devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!analysis?.segments?.length || !length) return;
    const bars = Math.floor(width / 4);
    const levels = new Array(bars).fill(0);
    for (const segment of analysis.segments) {
      const i = Math.min(bars - 1, Math.floor((segment.at / length) * bars));
      if (i >= 0) levels[i] = Math.max(levels[i], levelOf(segment.loud));
    }
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    levels.forEach((level, i) => {
      const h = Math.max(2, level * (height - 12)) * ratio;
      ctx.fillRect(i * 4 * ratio, (canvas.height - h) / 2, 2 * ratio, h);
    });
  }

  function tick(now) {
    if (!booth) return;
    frame = requestAnimationFrame(tick);
    const dt = Math.min(100, now - booth.last);
    if (dt < 30) return;
    booth.last = now;
    const state = readState();
    booth.state = state;
    const playing = !Spicetify.Player.data?.isPaused;
    const overlap = state.plan?.overlap;
    const effects = state.plan?.effects;
    const t = overlap && state.elapsed !== null && state.elapsed >= 0 && state.elapsed < overlap.durationMs ? state.elapsed / overlap.durationMs : null;
    const inMix = t !== null;

    const volA = inMix ? curveAt(effects?.out?.volume, t) ?? 1 - t : 1;
    const volB = inMix ? curveAt(effects?.in?.volume, t) ?? t : 0;
    const lengthA = state.a?.length || Spicetify.Player.getDuration();
    const positionA = state.mixing ? overlap.startAMs + state.elapsed * (overlap.speedA || 1) : state.position;
    const positionB = inMix ? overlap.startBMs + state.elapsed * (overlap.speedB || 1) : overlap?.startBMs ?? 0;
    const analysisA = analysisOf(state.a?.uri);
    const analysisB = analysisOf(state.b?.uri);
    const phaseA = beatPhase(analysisA, positionA, overlap?.bpmA, overlap?.startAMs ?? 0);
    const phaseB = beatPhase(analysisB, positionB, overlap?.bpmB, overlap?.startBMs ?? 0);
    // Sin análisis, el medidor rebota con el beat
    const loudA = loudnessAt(analysisA, positionA) ?? 0.65 + 0.3 * Math.pow(1 - phaseA, 2);
    const loudB = loudnessAt(analysisB, positionB) ?? 0.65 + 0.3 * Math.pow(1 - phaseB, 2);
    paintChannel(booth.channelA, effects?.out, t, playing ? volA * loudA : 0, dt);
    paintChannel(booth.channelB, effects?.in, t, playing && inMix ? volB * loudB : 0, dt);
    const mixAmount = volB / Math.max(0.001, volA + volB);
    setVar(booth.knob, "--x", `${Math.round(mixAmount * 100)}%`);

    const wet = (side) => {
      if (!inMix) return "";
      const echo = curveAt(side?.echo, t) ?? 0;
      const reverb = curveAt(side?.reverb, t) ?? 0;
      return [echo > 0.02 ? `ECHO ${Math.round(echo * 100)}%` : "", reverb > 0.02 ? `REVERB ${Math.round(reverb * 100)}%` : ""].filter(Boolean).join("  ");
    };
    const loopNow = inMix && state.plan?.blocks?.find((block) => t >= block.start && t < block.end);
    setText(booth.fxA, [wet(effects?.out), loopNow ? `LOOP ${loopNow.beats} BEATS` : ""].filter(Boolean).join("  ") || " ");
    setText(booth.fxB, wet(effects?.in) || " ");

    // La canción que Spotify tiene puesta es la que se puede rayar y mover: A antes de la mezcla, B durante ella
    paintDeck(booth.deckA, state.a, overlap?.bpmA, playing && (!state.mixing || volA > 0.02), dt, `−${time(lengthA - positionA)}`, phaseA, !state.mixing);
    paintDeck(booth.deckB, state.b, overlap?.bpmB, playing && inMix && volB > 0.02, dt, overlap ? `starts at ${time(overlap.startBMs)}` : "", phaseB, state.mixing);

    const untilMix = !inMix && overlap ? -state.elapsed : null;
    const status = inMix ? "Mixing" : overlap ? `Mix in ${time(untilMix)}` : state.context ? "No mix to the next song" : "Play a playlist to mix";
    setText(booth.status, status);
    booth.status.classList.toggle("is-live", inMix);
    booth.edit.disabled = !(state.context && state.a && state.b);

    // Cuenta atrás grande en los últimos diez segundos: cada número entra y se desvanece
    const seconds = playing && untilMix !== null && untilMix > 0 && untilMix <= 10000 ? Math.ceil(untilMix / 1000) : null;
    if (seconds !== booth.lastCount) {
      booth.lastCount = seconds;
      booth.count.classList.remove("is-on");
      if (seconds !== null) {
        booth.count.textContent = String(seconds);
        void booth.count.offsetWidth;
        booth.count.classList.add("is-on");
      }
    }

    // El fondo pasa de los colores de una canción a los de la otra según el crossfader
    const coverA = state.a?.cover ? `url("${state.a.cover}")` : "none";
    const coverB = state.b?.cover ? `url("${state.b.cover}")` : "none";
    if (booth.backdrop.style.backgroundImage !== coverA) booth.backdrop.style.backgroundImage = coverA;
    if (booth.backdropB.style.backgroundImage !== coverB) booth.backdropB.style.backgroundImage = coverB;
    setVar(booth.backdropB, "--o", (inMix ? mixAmount : 0).toFixed(2));

    // La barra de abajo es la canción que suena en Spotify, para poder moverse por ella
    const track = state.mixing ? state.b : state.a;
    const length = track?.length || Spicetify.Player.getDuration();
    booth.timelineLength = length;
    booth.timelineUri = track?.uri;
    drawWave(analysisOf(track?.uri), length);
    const holding = booth.dragUntil && performance.now() < booth.dragUntil;
    const position = booth.drag ?? (holding ? booth.dragHold : state.position);
    const fraction = (ms) => `${Math.min(100, Math.max(0, (ms / length) * 100)).toFixed(2)}%`;
    booth.played.style.width = fraction(position);
    booth.head.style.left = fraction(position);
    const zone = !overlap ? null : state.mixing
      ? [overlap.startBMs, overlap.durationMs * (overlap.speedB || 1)]
      : [overlap.startAMs, overlap.durationMs * (overlap.speedA || 1)];
    if (zone) {
      booth.mixZone.style.display = "";
      booth.mixZone.style.left = fraction(zone[0]);
      booth.mixZone.style.width = fraction(zone[1]);
    } else {
      booth.mixZone.style.display = "none";
    }
    setText(booth.timeText, `${time(position)} / ${time(length)}`);
    booth.timeline.setAttribute("aria-valuemax", String(Math.round(length / 1000)));
    booth.timeline.setAttribute("aria-valuenow", String(Math.round(position / 1000)));
    booth.timeline.setAttribute("aria-valuetext", `${time(position)} of ${time(length)}`);
  }

  // ---------- Editor ----------

  // La miniatura de un estilo: sus curvas dibujadas, la de salida en blanco y la de entrada en azul
  function thumbnail(kind, entry) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 96 40");
    svg.setAttribute("aria-hidden", "true");
    const draw = (curve, color) => {
      if (!curve?.curves?.length) return;
      const points = [];
      for (let i = 0; i <= 48; i++) {
        const t = i / 48;
        const y = curveAt(curve, t);
        if (y !== null) points.push(`${(t * 96).toFixed(1)},${(38 - y * 36).toFixed(1)}`);
      }
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("points", points.join(" "));
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", "2");
      svg.append(line);
    };
    if (kind === "loop") {
      for (const block of entry?.out?.blocks ?? []) {
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", (block.start * 96).toFixed(1));
        rect.setAttribute("width", Math.max(2, (block.end - block.start) * 96).toFixed(1));
        rect.setAttribute("y", "8");
        rect.setAttribute("height", "24");
        rect.setAttribute("rx", "3");
        rect.setAttribute("fill", "rgba(255,77,109,0.6)");
        svg.append(rect);
      }
    } else if (entry) {
      // Las curvas principales del tipo; si el estilo usa otras (medios, agudos, resonancia), esas
      const used = Object.keys(entry).filter((name) => name !== "style" && entry[name]?.curves?.length);
      const main = KINDS[kind].curves.filter((name) => used.includes(name));
      const chosen = main.length ? main : used.slice(0, 2);
      chosen.forEach((name, i) => draw(entry[name], i === 0 ? "#fff" : "#6df0ff"));
    } else {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      Object.entries({ x1: 0, y1: 20, x2: 96, y2: 20, stroke: "rgba(255,255,255,0.35)", "stroke-dasharray": "4 4" }).forEach(([k, v]) => line.setAttribute(k, v));
      svg.append(line);
    }
    return svg;
  }

  const styleName = (kind, entry) => {
    if (!entry) return "None";
    if (kind === "loop") {
      const beats = entry.out.blocks[0].beats;
      return entry.out.blocks.length > 1 ? "Roll" : `${beats} ${beats === 1 ? "beat" : "beats"}`;
    }
    return `${KINDS[kind].label} ${entry.style.id}`;
  };

  // Una copia de la transición que se puede tocar sin cambiar la original
  const clone = (value) => JSON.parse(JSON.stringify(value));

  async function openEditor({ contextUri, aUri, bUri, aUid }) {
    if (!booth) openBooth();
    closeEditor();
    const panel = el("div", "mb-editor", booth.root);
    booth.editor = panel;
    const heading = el("h2", "", panel);
    heading.textContent = "Loading transition…";

    let composed, items, meta;
    try {
      [composed, { items }, meta] = await Promise.all([
        api.getComposedTransitionForTrackPair(contextUri, aUri, bUri, aUid ? { trackAUid: aUid } : undefined),
        P.PlaylistAPI.getContents(contextUri, { limit: 1000 }),
        P.PlaylistAPI.getMetadata(contextUri),
      ]);
    } catch {
      heading.textContent = "This transition can't be edited.";
      return;
    }
    if (booth?.editor !== panel) return;
    if (!composed?.overlap?.durationMs) {
      heading.textContent = "These two songs don't have a mix.";
      return;
    }
    const nameOf = (uri) => items.find((item) => item.uri === uri)?.name ?? "";
    heading.textContent = "Edit transition";
    const sub = el("small", "", heading);
    sub.textContent = `${nameOf(aUri)}  →  ${nameOf(bUri)}`;

    const draft = { overlap: clone(composed.overlap), preset: clone(composed.preset ?? {}) };
    const original = { overlap: clone(composed.overlap), preset: clone(composed.preset ?? {}) };
    const canEdit = meta?.permissions?.canEditItems ?? meta?.isOwnedBySelf ?? false;

    // Elegir un estilo quita las curvas propias de ese tipo, para que suene el estilo elegido
    const OWN_CURVES = {
      volume: ["volumeOutCurveOverride", "volumeInCurveOverride"],
      eq: ["eqOutCurveOverrides", "eqInCurveOverrides"],
      filter: ["filterOutCurveOverrides", "filterInCurveOverrides"],
      fx: ["fxOutCurveOverrides", "fxInCurveOverrides"],
      loop: ["loopingOutBlocksOverride"],
    };

    for (const kind of Object.keys(KINDS)) {
      const group = el("div", "mb-group", panel);
      el("h3", "", group).textContent = KINDS[kind].label;
      const cards = el("div", "mb-cards", group);
      cards.setAttribute("role", "radiogroup");
      cards.setAttribute("aria-label", KINDS[kind].label);
      const entries = [null, ...(await stylesOf(kind))];
      // Si la transición trae curvas propias de este tipo, se ofrecen como "Custom" para poder volver a ellas
      const ownCurves = OWN_CURVES[kind].filter((name) => original.preset[name]);
      if (ownCurves.length) {
        const button = el("button", "mb-card", cards);
        button.type = "button";
        button.setAttribute("role", "radio");
        // La miniatura de las curvas propias: las de salida y entrada del primer grupo que haya
        const firstCurve = (value) => (value?.curves ? value : Object.values(value ?? {}).find((v) => v?.curves));
        const pseudo = { style: { id: -1 } };
        KINDS[kind].curves.forEach((name, i) => {
          const source = firstCurve(original.preset[OWN_CURVES[kind][i]]);
          if (source) pseudo[name] = source;
        });
        if (kind === "loop") pseudo.out = original.preset.loopingOutBlocksOverride;
        button.append(thumbnail(kind, pseudo));
        el("span", "", button).textContent = "Custom";
        button.addEventListener("click", () => {
          for (const name of OWN_CURVES[kind]) {
            if (original.preset[name]) draft.preset[name] = clone(original.preset[name]);
          }
          draft.preset[KINDS[kind].key] = clone(original.preset[KINDS[kind].key] ?? { id: 0 });
          refresh();
        });
        cards.customButton = button;
      }
      const buttons = entries.map((entry) => {
        const button = el("button", "mb-card", cards);
        button.type = "button";
        button.setAttribute("role", "radio");
        button.append(thumbnail(kind, entry));
        el("span", "", button).textContent = styleName(kind, entry);
        button.addEventListener("click", () => {
          const id = entry?.style.id ?? 0;
          draft.preset[KINDS[kind].key] = { id };
          for (const name of OWN_CURVES[kind]) delete draft.preset[name];
          refresh();
        });
        return { button, id: entry?.style.id ?? 0 };
      });
      const refresh = () => {
        const chosen = draft.preset[KINDS[kind].key]?.id ?? 0;
        const custom = OWN_CURVES[kind].some((name) => draft.preset[name]);
        for (const { button, id } of buttons) {
          const on = !custom && id === chosen;
          button.classList.toggle("is-on", on);
          button.setAttribute("aria-checked", String(on));
        }
        if (cards.customButton) {
          cards.customButton.classList.toggle("is-on", custom);
          cards.customButton.setAttribute("aria-checked", String(custom));
        }
      };
      refresh();
    }

    // Dónde empieza la mezcla en cada canción, por compases, y cuánto dura
    const barMs = (bpm, speed) => (4 * 60000) / ((bpm || 120) * (speed || 1));
    const timing = el("div", "mb-group", panel);
    el("h3", "", timing).textContent = "Timing";
    const nudger = (label, read, change) => {
      const row = el("div", "mb-row", timing);
      el("label", "", row).textContent = label;
      const less = el("button", "mb-btn", row);
      less.textContent = "−1 bar";
      const out = el("output", "", row);
      const more = el("button", "mb-btn", row);
      more.textContent = "+1 bar";
      const show = () => (out.textContent = read());
      less.addEventListener("click", () => { change(-1); show(); });
      more.addEventListener("click", () => { change(1); show(); });
      show();
    };
    const o = draft.overlap;
    nudger("Mix starts in song A", () => time(o.startAMs), (d) => {
      o.startAMs = Math.max(0, Math.round(o.startAMs + d * barMs(o.bpmA, 1)));
    });
    nudger("Song B comes in at", () => time(o.startBMs), (d) => {
      o.startBMs = Math.max(0, Math.round(o.startBMs + d * barMs(o.bpmB, 1)));
    });
    nudger("Length", () => `${o.durationBars} bars`, (d) => {
      const bars = Math.min(64, Math.max(1, o.durationBars + d));
      o.durationMs = Math.round((o.durationMs / o.durationBars) * bars);
      o.durationBars = bars;
    });

    const actions = el("div", "mb-row", panel);
    const preview = el("button", "mb-btn", actions);
    preview.textContent = "▶  Preview";
    const save = el("button", "mb-btn is-primary", actions);
    save.textContent = "Save to playlist";
    const reset = el("button", "mb-btn", actions);
    reset.textContent = "Undo changes";
    const back = el("button", "mb-btn", actions);
    back.textContent = "Back";
    const note = el("p", "mb-note", panel);
    note.textContent = canEdit ? "Preview plays the mix from a few seconds before it starts, then goes back to what you were playing." : "You can preview this mix, but only the playlist's owner can save changes.";
    save.disabled = !canEdit;

    preview.addEventListener("click", async () => {
      try {
        await api.playTransitionPreview({ overlap: draft.overlap, preset: draft.preset }, contextUri, aUri, bUri);
      } catch {
        note.textContent = "Spotify couldn't preview this mix.";
      }
    });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const previousType = composed.isOverlapOverride || composed.isPresetIdOverride ? "userDefined" : "auto";
        await api.setTransitionForTrack(contextUri, composed.overlap.trackARowId, { overlap: draft.overlap, preset: draft.preset }, { previousTransition: { type: previousType, transition: original } });
        plans.clear();
        note.textContent = "Saved. The playlist will use this mix from now on.";
        Spicetify.showNotification?.("Transition saved");
      } catch {
        note.textContent = "Spotify didn't accept this change. Nothing was saved.";
      }
      save.disabled = !canEdit;
    });
    reset.addEventListener("click", () => {
      const panelAgain = openEditor({ contextUri, aUri, bUri, aUid });
      return panelAgain;
    });
    back.addEventListener("click", closeEditor);
    back.focus();
  }

  function closeEditor() {
    if (!booth?.editor) return;
    api.isTransitionPreviewActive?.() && api.stopTransitionPreview?.().catch(() => {});
    booth.editor.remove();
    booth.editor = null;
  }

  // ---------- Entradas ----------

  // Con ancho y alto: sin ellos Spotify deja el icono a tamaño cero y el botón se ve vacío
  const ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="4.5" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="8" r="1"/><circle cx="11.5" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="8" r="1"/></svg>`;
  const boothButton = new Spicetify.Playbar.Button("Mix Booth", ICON, (button) => {
    if (booth) closeBooth();
    else {
      openBooth();
      button.active = true;
    }
  }, false, false);
  boothButton.register();
  // Spicetify solo le pone un tooltip: sin nombre, los lectores de pantalla no sabrían qué es
  boothButton.element?.setAttribute("aria-label", "Mix Booth");

  // Clic derecho en una canción de una playlist: editar la mezcla con la siguiente
  new Spicetify.ContextMenu.Item(
    "Edit transition to next song",
    async (uris, uids, contextUri) => {
      const { items } = await P.PlaylistAPI.getContents(contextUri, { limit: 1000 });
      const index = items.findIndex((item) => (uids?.[0] ? item.uid === uids[0] : item.uri === uris[0]));
      const next = items[index + 1];
      if (index < 0 || !next) {
        Spicetify.showNotification?.("This is the last song: there's no transition after it.");
        return;
      }
      openEditor({ contextUri, aUri: items[index].uri, bUri: next.uri, aUid: items[index].uid });
    },
    (uris, uids, contextUri) => uris.length === 1 && uris[0].startsWith("spotify:track:") && !!contextUri?.startsWith("spotify:playlist:"),
  ).register();
})();
