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

  const imageUrl = (image) => (image?.startsWith("spotify:image:") ? `https://i.scdn.co/image/${image.split(":").pop()}` : image ?? null);
  // La etiqueta del disco mide unos 130 px: la portada de 300 px basta y se decodifica mucho más rápido que la de 640
  const coverOf = (meta) => imageUrl(meta?.image_large_url ?? meta?.image_url ?? meta?.image_xlarge_url ?? meta?.image_small_url);
  // Para el fondo, que va desenfocado, sobra con la más pequeña
  const smallCoverOf = (meta) => imageUrl(meta?.image_small_url ?? meta?.image_url ?? meta?.image_large_url);

  const trackInfo = (item) => item?.uri ? {
    uri: item.uri,
    name: item.name ?? item.metadata?.title ?? "",
    artist: item.artists?.map((a) => a.name).join(", ") ?? item.metadata?.artist_name ?? "",
    cover: coverOf(item.metadata) ?? item.images?.[0]?.url ?? null,
    // La más grande, para los clips a 1080×1920
    big: imageUrl(item.metadata?.image_xlarge_url ?? item.metadata?.image_large_url) ?? item.images?.[0]?.url ?? null,
    small: smallCoverOf(item.metadata) ?? item.images?.[item.images.length - 1]?.url ?? null,
    length: item.duration?.milliseconds ?? Number(item.metadata?.duration) ?? 0,
  } : null;

  // Las imágenes se descargan y decodifican aparte, y solo se cambian ya listas: así el cambio de canción no frena la pantalla
  const decoded = new Map();
  function whenDecoded(url) {
    if (!url) return Promise.resolve(null);
    if (!decoded.has(url)) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.src = url;
      decoded.set(url, img.decode().then(() => img, () => null));
      if (decoded.size > 12) decoded.delete(decoded.keys().next().value);
    }
    return decoded.get(url);
  }

  // El fondo: la portada pintada una vez en un lienzo diminuto ya desenfocado y estirado por CSS.
  // Se ve igual de borroso que un desenfoque en vivo y no cuesta nada al cambiar de canción
  function paintBackdrop(canvas, url) {
    if (canvas.dataset.url === (url ?? "")) return;
    canvas.dataset.url = url ?? "";
    whenDecoded(url).then((img) => {
      if (canvas.dataset.url !== (url ?? "")) return;
      const ctx = canvas.getContext("2d");
      canvas.width = canvas.height = 32;
      ctx.clearRect(0, 0, 32, 32);
      if (!img) return;
      ctx.filter = "blur(3px) saturate(1.6) brightness(0.4)";
      ctx.drawImage(img, -6, -6, 44, 44);
    });
  }

  function setLabelImage(label, url) {
    if (label.dataset.url === (url ?? "")) return;
    label.dataset.url = url ?? "";
    whenDecoded(url).then((img) => {
      if (label.dataset.url !== (url ?? "")) return;
      label.style.backgroundImage = img ? `url("${url}")` : "none";
    });
  }

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
    /* Con la cabina abierta no se ve nada de Spotify: el navegador deja de dibujarlo. Así, al cambiar de canción,
       la letra del panel y el resto de la página no frenan la cabina. Todo sigue funcionando debajo */
    html.mb-open #main { content-visibility: hidden; }
    /* Además se saca del layout lo que la cabina tapa: al cambiar de canción Spotify mide el título, la vista
       central y el panel de letra, y cada medida obligaba a recalcular la página entera (un tirón de ~300 ms) */
    html.mb-open .Root__top-container > * { display: none !important; }
    .mb-backdrop {
      position: absolute;
      top: -10%;
      left: -10%;
      z-index: -1;
      width: 120%;
      height: 120%;
      animation: mb-drift 38s ease-in-out infinite alternate;
      will-change: transform;
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
      border: 2px solid rgba(var(--glow), 0.12);
      pointer-events: none;
    }
    /* El destello va en su propia capa, pintada una vez: en cada beat solo cambia su opacidad */
    .mb-ring::after {
      content: "";
      position: absolute;
      inset: -2px;
      border-radius: 50%;
      border: 2px solid rgba(var(--glow), 0.75);
      box-shadow: 0 0 56px rgba(var(--glow), 0.55);
      opacity: var(--beat, 0);
      will-change: opacity;
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
      box-shadow: 0 0 0 3px #0a0a0a;
      scale: calc(1 + var(--beat, 0) * 0.035);
      will-change: scale;
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
    /* El medidor completo se pinta una vez y se tapa desde arriba: subir y bajar es solo mover una capa */
    .mb-meter b { position: absolute; inset: 0; background: linear-gradient(0deg, #4dff9a, #ffe14d 70%, #ff4d6d); }
    .mb-meter i { position: absolute; inset: 0; background: #1a1a1a; transform-origin: top; transform: scaleY(calc(1 - var(--v, 0))); will-change: transform; }
    .mb-meter u { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: #fff; opacity: 0.85; transform: translateY(calc(var(--p, 0) * -90px)); will-change: transform; }
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
    .mb-rec { color: #ff6b8a; border-color: rgba(255, 107, 138, 0.5); }
    /* Punto de grabar dibujado: el símbolo ⏺ sale como emoji azul en Windows */
    .mb-dot { display: inline-block; width: 10px; height: 10px; margin-right: 8px; border-radius: 50%; background: #ff3b5c; box-shadow: 0 0 8px rgba(255, 59, 92, 0.7); vertical-align: 0; }
    .mb-btn.is-on { background: #fff; color: #000; border-color: #fff; }
    .mb-clip-setup {
      position: absolute;
      inset: 0;
      z-index: 3;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 36px;
      overflow: auto;
      background: rgba(7, 8, 13, 0.95);
      animation: mb-in 0.25s ease;
    }
    .mb-clip-setup h2 { margin: 0; font-size: 26px; }
    .mb-clip-styles { display: flex; gap: 22px; }
    .mb-clip-style {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 12px;
      border: 2px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.04);
      color: #fff;
      font: inherit;
      cursor: pointer;
    }
    .mb-clip-style canvas { width: 200px; height: 356px; border-radius: 12px; background: #000; }
    .mb-clip-style b { font-size: 17px; }
    .mb-clip-style span { font-size: 12px; opacity: 0.6; }
    .mb-clip-style.is-on { border-color: #fff; background: rgba(255, 255, 255, 0.1); }
    .mb-clip-style:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
    .mb-input {
      min-width: 280px;
      padding: 9px 14px;
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      color: #fff;
      font: inherit;
      font-size: 13px;
    }
    .mb-input:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    /* Vista de grabación: el vídeo vertical llena el alto de la ventana; los mandos quedan fuera de él */
    .mb-clip {
      position: fixed;
      inset: 0;
      z-index: 10001;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 32px;
      background: #000;
      color: #fff;
      font-family: var(--encore-body-font-stack, sans-serif);
    }
    .mb-clip-canvas { height: 100vh; aspect-ratio: 9 / 16; display: block; }
    .mb-clip-side { display: flex; flex-direction: column; gap: 12px; width: 220px; }
    .mb-clip-side h2 { margin: 0; font-size: 22px; letter-spacing: 0.1em; text-transform: uppercase; }
    .mb-clip-status { margin: 0; font-size: 14px; opacity: 0.75; }
    .mb-clip-counter { font-size: 44px; font-weight: 800; font-variant-numeric: tabular-nums; color: #ff6b8a; min-height: 52px; }
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
    el("b", "", meter);
    const level = el("i", "", meter);
    const peakMark = el("u", "", meter);
    return { knobs, level, peakMark, peak: 0 };
  }

  let booth = null;
  let frame = 0;

  let savedScroll = [];
  function openBooth() {
    if (booth) return;
    const root = el("div", "mb-booth", document.body);
    // Lo oculto pierde su scroll; se apunta para devolverlo al cerrar
    savedScroll = [...document.querySelectorAll(".Root__top-container [data-overlayscrollbars-viewport], .Root__top-container [class*='scroll-node'], .Root__top-container [class*='Scroll']")]
      .filter((node) => node.scrollTop > 0).map((node) => [node, node.scrollTop]);
    document.documentElement.classList.add("mb-open");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Mix Booth");
    const backdrop = el("canvas", "mb-backdrop", root);
    const backdropB = el("canvas", "mb-backdrop mb-backdrop-b", root);
    const count = el("div", "mb-count", root);
    count.setAttribute("aria-hidden", "true");
    const top = el("div", "mb-top", root);
    el("h1", "", top).textContent = "Mix Booth";
    const status = el("span", "mb-status", top);
    const record = el("button", "mb-btn mb-rec", top);
    record.innerHTML = '<i class="mb-dot" aria-hidden="true"></i>Clip';
    record.setAttribute("aria-label", "Record a vertical clip");
    record.addEventListener("click", openClipSetup);
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

    booth.waveObserver = new ResizeObserver(([entry]) => {
      if (booth) booth.waveSize = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) };
    });
    booth.waveObserver.observe(wave);

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
      if (event.key === "Escape") (booth?.clipSetup ? booth.clipSetup.close() : booth?.editor ? closeEditor() : closeBooth());
    });
    close.focus();
    frame = requestAnimationFrame(tick);
  }

  function closeBooth() {
    if (!booth) return;
    cancelAnimationFrame(frame);
    document.documentElement.classList.remove("mb-open");
    for (const [node, top] of savedScroll) if (node.isConnected) node.scrollTop = top;
    savedScroll = [];
    booth.waveObserver?.disconnect();
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
      // elapsed es tiempo real desde que empezó la mezcla; durante ella Spotify acelera o frena cada
      // canción para cuadrar el tempo (speedA/speedB), así que la posición de la canción va a otro ritmo
      const elapsed = behind.overlap ? (position - behind.overlap.startBMs) / (behind.overlap.speedB || 1) : -1;
      // Mientras aún no se sabe dónde entró (los primeros 400 ms), se da por buena la mezcla si la posición
      // cae dentro de ella: si no, durante ese instante parecería que la mezcla ya terminó
      const enteredAtMix = behind.overlap && (change.entry === null || Math.abs(change.entry - behind.overlap.startBMs) < MIX_ENTRY_TOLERANCE_MS);
      if (behind.ready && enteredAtMix && elapsed >= 0 && elapsed < behind.overlap.durationMs) {
        return { context, a: previous, b: current, mixing: true, elapsed, position, plan: behind };
      }
    }
    const ahead = isPlaylist && current && next ? getPlan(context, current.uri, next.uri) : null;
    const usable = ahead?.ready && ahead.overlap ? ahead : null;
    return { context: isPlaylist ? context : null, a: current, b: next, mixing: false, elapsed: usable ? (position - usable.overlap.startAMs) / (usable.overlap.speedA || 1) : null, position, plan: usable };
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
    setVar(channel.level, "--v", level.toFixed(2));
    setVar(channel.peakMark, "--p", channel.peak.toFixed(2));
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
    setLabelImage(deck.label, track?.cover);
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
    // El tamaño lo da el observador: leerlo aquí en cada cuadro obligaría a recalcular toda la página
    const { width, height } = booth.waveSize ?? { width: 0, height: 0 };
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
    paintBackdrop(booth.backdrop, state.a?.small ?? state.a?.cover);
    paintBackdrop(booth.backdropB, state.b?.small ?? state.b?.cover);
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

  // ---------- Clips en vertical ----------
  // Un visualizador de 1080×1920 para grabar la canción o la mezcla. La grabación la hace OBS, que
  // captura esta ventana con el sonido de Spotify; la extensión solo le dice cuándo empezar y parar

  const CLIP_W = 1080, CLIP_H = 1920;
  const CLIP_STYLE_KEY = "mix-booth:clip-style";
  const CLIP_MODE_KEY = "mix-booth:clip-mode";
  const OBS_PASSWORD_KEY = "mix-booth:obs-password";
  const store = {
    get: (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
    set: (key, value) => { try { localStorage.setItem(key, value); } catch {} },
  };

  // Las fuentes del diseño no vienen con Spotify: se cargan al abrir el panel de clips
  let fontsReady = null;
  function loadClipFonts() {
    if (!fontsReady) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@500;600;700;800&display=swap";
      document.head.append(link);
      fontsReady = new Promise((ok) => { link.onload = ok; link.onerror = ok; setTimeout(ok, 4000); })
        .then(() => Promise.all(["120px Anton", "800 64px Inter", "500 38px Inter", "700 40px Inter", "600 30px Inter"].map((f) => document.fonts.load(f).catch(() => {}))));
    }
    return fontsReady;
  }

  // Letra: primero la que Spicy Lyrics ya guardó en este PC, si no la de Spotify
  const SPICY_CACHE = "SpicyLyrics_LyricsStore_g1";
  const lyricsCache = new Map();
  function normalizeSpicy(content) {
    const lines = [];
    const fromPart = (part) => ({ start: part.StartTime * 1000, end: part.EndTime * 1000, words: part.Syllables.map((s) => ({ text: s.Text, start: s.StartTime * 1000, end: s.EndTime * 1000, joined: !!s.IsPartOfWord })) });
    for (const item of content?.Content ?? []) {
      if (item.Lead?.Syllables?.length) lines.push(fromPart(item.Lead));
      else if (typeof item.Text === "string" && item.Text.trim()) {
        const start = item.StartTime * 1000, end = item.EndTime * 1000;
        const words = item.Text.split(/\s+/).filter(Boolean);
        const per = (end - start) / Math.max(1, words.length);
        lines.push({ start, end, words: words.map((text, i) => ({ text, start: start + i * per, end: start + (i + 1) * per, joined: false })) });
      }
    }
    return lines;
  }
  function normalizeSpotify(result) {
    if (result?.lyrics?.syncType === "UNSYNCED") return [];
    const raw = result?.lyrics?.lines ?? [];
    return raw.map((line, i) => {
      const start = Number(line.startTimeMs), end = Number(raw[i + 1]?.startTimeMs ?? start + 4000);
      const words = (line.words ?? "").split(/\s+/).filter(Boolean);
      const per = (end - start) / Math.max(1, words.length);
      return { start, end, words: words.map((text, k) => ({ text, start: start + k * per, end: start + (k + 1) * per, joined: false })) };
    }).filter((line) => line.words.length && !/^♪$/.test(line.words[0].text));
  }
  // Las sílabas de una palabra se juntan: el clip anima palabras enteras
  function toWords(lines) {
    return lines.map((line) => {
      const words = [];
      for (const w of line.words) {
        const last = words[words.length - 1];
        if (last?.open) { last.text += w.text; last.end = w.end; last.open = w.joined; }
        else words.push({ text: w.text, start: w.start, end: w.end, open: w.joined });
      }
      return { start: line.start, end: line.end, words: words.map(({ open, ...w }) => ({ ...w, text: w.text.trim() })).filter((w) => w.text) };
    }).filter((line) => line.words.length);
  }
  function lyricsOf(uri) {
    if (!uri) return null;
    if (!lyricsCache.has(uri)) {
      lyricsCache.set(uri, null);
      (async () => {
        const id = uri.split(":").pop();
        let lines = [];
        try {
          const hit = await (await caches.open(SPICY_CACHE)).match(`/${id}`);
          if (hit) lines = normalizeSpicy((await hit.json()).Content);
        } catch {}
        if (!lines.length) {
          try { lines = normalizeSpotify(await Spicetify.CosmosAsync.get(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&market=from_token`)); } catch {}
        }
        lyricsCache.set(uri, toWords(lines));
        if (lyricsCache.size > 8) lyricsCache.delete(lyricsCache.keys().next().value);
      })();
    }
    return lyricsCache.get(uri);
  }

  // Colores de la portada: cuatro vivos y distintos entre sí, y uno oscuro para el fondo
  const paletteCache = new Map();
  function paletteOf(url) {
    if (!url) return null;
    if (!paletteCache.has(url)) {
      paletteCache.set(url, null);
      whenDecoded(url).then((img) => {
        if (!img) return;
        const c = document.createElement("canvas"); c.width = c.height = 32;
        const x = c.getContext("2d"); x.drawImage(img, 0, 0, 32, 32);
        let d; try { d = x.getImageData(0, 0, 32, 32).data; } catch { return; }
        const px = []; for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
        const sat = (p) => Math.max(...p) - Math.min(...p), lum = (p) => 0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2];
        const bySat = [...px].sort((a, b) => sat(b) * (lum(b) > 50 ? 1 : 0.3) - sat(a) * (lum(a) > 50 ? 1 : 0.3));
        const picks = [];
        for (const p of bySat) { if (picks.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 70)) picks.push(p); if (picks.length === 4) break; }
        while (picks.length < 4) picks.push(bySat[picks.length * 10] ?? [200, 80, 160]);
        paletteCache.set(url, { vivid: picks[0], c: picks, deep: [...px].sort((a, b) => lum(a) - lum(b))[Math.floor(px.length * 0.1)] });
      });
    }
    return paletteCache.get(url);
  }
  const FALLBACK_PALETTE = { vivid: [255, 70, 150], c: [[255, 70, 150], [120, 80, 255], [40, 200, 255], [255, 170, 60]], deep: [20, 10, 40] };

  // Lo que el clip necesita en cada cuadro, sacado de lo que está sonando y de su mezcla
  function clipFrame(now) {
    const s = readState();
    const ov = s.plan?.overlap;
    const inMix = ov && s.elapsed !== null && s.elapsed >= 0 && s.elapsed < ov.durationMs;
    const m = inMix ? s.elapsed / ov.durationMs : s.mixing ? 1 : 0;
    const posA = s.mixing ? ov.startAMs + s.elapsed * (ov.speedA || 1) : s.position;
    const posB = inMix ? ov.startBMs + s.elapsed * (ov.speedB || 1) : 0;
    const song = (track, pos, bpm, anchor) => {
      const cover = track?.cover;
      const lines = lyricsOf(track?.uri);
      const line = lines ? lineAt(lines, pos) : null;
      const analysis = analysisOf(track?.uri);
      return {
        title: track?.name ?? "", artist: track?.artist ?? "", uri: track?.uri, bpm: bpm ? Math.round(bpm) : null,
        img: cover ? decodedNow(cover) : null, pal: paletteOf(cover) ?? FALLBACK_PALETTE,
        pos, length: track?.length || 1, line, hasLyrics: !!lines?.length,
        beat: beatPulse(beatPhase(analysis, pos, bpm, anchor ?? 0)),
        // Para la forma de onda: volumen de cada tramo y dónde cae cada beat
        segs: analysis?.segments ?? null, beats: analysis?.beats ?? null, lines: lines ?? null,
      };
    };
    const a = song(s.a, posA, ov?.bpmA, ov?.startAMs);
    const b = s.b ? song(s.b, posB, ov?.bpmB, ov?.startBMs) : null;
    return { now: now / 1000, m, inMix, mixing: s.mixing, dur: ov?.durationMs || 1, a, b, cur: m < 0.5 || !b ? a : b, state: s };
  }
  // Imágenes ya listas para pintar (sin esperar)
  const decodedNowCache = new Map();
  function decodedNow(url) {
    if (!decodedNowCache.has(url)) { decodedNowCache.set(url, null); whenDecoded(url).then((img) => decodedNowCache.set(url, img)); }
    return decodedNowCache.get(url);
  }
  // La línea que suena; entre líneas se mantiene la anterior un momento
  function lineAt(lines, pos) {
    let found = null;
    for (const line of lines) { if (line.start <= pos + 120) found = line; else break; }
    if (found && pos > found.end + 1500) return null;
    return found;
  }

  // <clip-art> Desde aquí hasta </clip-art> es el dibujo de los clips. No depende de nada de fuera:
  // la página que OBS dibuja a 1080×1920 copia este trozo tal cual (ver clipRendererUrl)
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
  const easeBack = (x) => { x = clamp01(x); const c = 1.7; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const smoothStep = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  // El golpe de cada beat: sube en unas centésimas (no de un cuadro a otro, que en vídeo parece que tiembla) y se apaga
  const beatPulse = (phase) => (phase < 0.07 ? smoothStep(phase / 0.07) : Math.exp(-(phase - 0.07) * 4.5));
  // Dónde está la frontera entre las dos canciones durante la mezcla: entra rápido hasta la mitad,
  // las dos comparten pantalla casi toda la mezcla, y al final la nueva se queda con todo
  const splitLevel = (m) => Math.round(CLIP_H * (1 - 0.5 * smoothStep(m / 0.18) - 0.5 * smoothStep((m - 0.82) / 0.18)));
  const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const mixColor = (p, q, m) => p.map((v, i) => Math.round(v + (q[i] - v) * m));
  const rr = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
  const grainTile = (() => { const c = document.createElement("canvas"); c.width = c.height = 256; const x = c.getContext("2d"); const d = x.createImageData(256, 256); for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 26; } x.putImageData(d, 0, 0); return c; })();
  const addGrain = (ctx) => { ctx.globalCompositeOperation = "overlay"; ctx.fillStyle = ctx.createPattern(grainTile, "repeat"); ctx.fillRect(0, 0, CLIP_W, CLIP_H); ctx.globalCompositeOperation = "source-over"; };

  // ----- Estilo Aura -----
  const auraBuf = document.createElement("canvas"); auraBuf.width = 54; auraBuf.height = 96;
  function auraField(ctx, pal, t, alpha, energy) {
    const x = auraBuf.getContext("2d");
    x.fillStyle = rgba(pal.deep); x.fillRect(0, 0, 54, 96);
    pal.c.forEach((col, i) => {
      const px = 27 + Math.sin(t * (0.35 + i * 0.13) + i * 2) * 22, py = 48 + Math.cos(t * (0.28 + i * 0.11) + i) * 40;
      const r = 34 + 8 * Math.sin(t * 0.7 + i) + energy * 6;
      const g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, rgba(col, 0.95)); g.addColorStop(1, rgba(col, 0));
      x.fillStyle = g; x.fillRect(0, 0, 54, 96);
    });
    ctx.save(); ctx.globalAlpha = alpha; ctx.filter = "blur(30px) saturate(1.25)"; ctx.drawImage(auraBuf, -60, -60, CLIP_W + 120, CLIP_H + 120); ctx.restore();
  }
  function floatingCover(ctx, img, cx, cy, size, t, beat, alpha = 1, blur = 0) {
    if (!img || alpha <= 0) return;
    ctx.save(); ctx.globalAlpha = alpha; if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;
    ctx.translate(cx, cy + Math.sin(t * 1.1) * 10); ctx.rotate(Math.sin(t * 0.6) * 0.02);
    const s = size * (1 + beat * 0.02);
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 80; ctx.shadowOffsetY = 40;
    rr(ctx, -s / 2, -s / 2, s, s, 34); ctx.fillStyle = "#000"; ctx.fill(); ctx.shadowColor = "transparent";
    rr(ctx, -s / 2, -s / 2, s, s, 34); ctx.clip(); ctx.drawImage(img, -s / 2, -s / 2, s, s);
    const gl = ctx.createLinearGradient(-s / 2, -s / 2, s / 2, s / 2); gl.addColorStop(0, "rgba(255,255,255,.22)"); gl.addColorStop(0.4, "rgba(255,255,255,0)"); ctx.fillStyle = gl; ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.restore();
  }
  // Cada palabra llega desde el desenfoque, subiendo; la que suena se ve más grande y brilla
  function auraWords(ctx, song, cx, y, fontPx, maxW) {
    const line = song.line;
    const words = line?.words ?? (song.hasLyrics ? [] : song.title.split(" ").map((text) => ({ text, start: -1, end: Infinity })));
    if (!words.length) return;
    const pos = song.pos;
    ctx.font = `800 ${fontPx}px Inter, ${getComputedStyle(document.body).fontFamily}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    // Espacio algo más ancho de lo normal: la palabra que suena crece un 6% y si no se comería el hueco
    const sp = ctx.measureText(" ").width * 1.7, ws = words.map((w) => ctx.measureText(w.text).width);
    const rows = [[]]; let lw = 0;
    words.forEach((w, i) => { if (lw + ws[i] > maxW && rows[rows.length - 1].length) { rows.push([]); lw = 0; } rows[rows.length - 1].push(i); lw += ws[i] + sp; });
    const out = line ? clamp01((line.end + 600 - pos) / 400) : 1;
    rows.slice(0, 3).forEach((row, ri) => {
      const total = row.reduce((s, i) => s + ws[i], 0) + sp * (row.length - 1);
      let x = cx - total / 2;
      for (const i of row) {
        const w = words[i];
        const k = w.start < 0 ? 1 : clamp01((pos - w.start + 160) / 360);
        const active = pos >= w.start && pos < w.end + 120;
        if (k > 0) {
          ctx.save(); ctx.globalAlpha = easeOut(k) * out * (active || w.start < 0 ? 1 : 0.62);
          const yy = y + ri * fontPx * 1.15 + (1 - easeOut(k)) * 40 - (1 - out) * 30;
          const blur = (1 - easeOut(k)) * 14 + (1 - out) * 10;
          if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;
          ctx.translate(x + ws[i] / 2, yy); if (active) ctx.scale(1.06, 1.06);
          ctx.fillStyle = "#fff"; if (active) { ctx.shadowColor = "rgba(255,255,255,.55)"; ctx.shadowBlur = 30; }
          ctx.fillText(w.text, -ws[i] / 2, 0); ctx.restore();
        }
        x += ws[i] + sp;
      }
    });
  }
  // Una canción dentro de una franja de la pantalla: portada, título y letra escalados a su alto.
  // Con la franja entera queda igual que el diseño de una sola canción
  function auraRegion(ctx, song, y0, y1, t) {
    const h = y1 - y0, k = h / CLIP_H;
    if (h < 60) return;
    floatingCover(ctx, song.img, CLIP_W / 2, y0 + h * 0.365, 620 * k, t, song.beat, 1);
    const titleY = y0 + h * 0.6;
    ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.globalAlpha = 1;
    fitText(ctx, song.title, 900, Math.round(Math.max(34, 64 * k)), "800", "Inter"); ctx.fillText(song.title, CLIP_W / 2, titleY);
    ctx.globalAlpha = 0.75; ctx.font = `500 ${Math.round(Math.max(24, 38 * k))}px Inter`; ctx.fillText(song.artist, CLIP_W / 2, titleY + Math.max(34, 55 * k)); ctx.globalAlpha = 1;
    auraWords(ctx, song, CLIP_W / 2, y0 + h * 0.74, Math.round(Math.max(56, 84 * k)), 920);
  }
  const waveY = (x, level, t, m) => level + Math.sin(x / 140 + t * 3) * 30 * Math.sin(m * Math.PI) + Math.sin(x / 60 - t * 5) * 8 * Math.sin(m * Math.PI);
  function wavePath(ctx, level, t, m, toBottom) {
    ctx.beginPath();
    ctx.moveTo(0, toBottom ? CLIP_H : 0);
    for (let x = 0; x <= CLIP_W; x += 20) ctx.lineTo(x, waveY(x, level, t, m));
    ctx.lineTo(CLIP_W, toBottom ? CLIP_H : 0); ctx.closePath();
  }
  function drawAura(ctx, F) {
    const { m, a, b, cur, now: t } = F;
    // Durante la mezcla las dos canciones comparten la pantalla: la que sale arriba, la que entra abajo.
    // La ola líquida es la frontera y sube según avanza la mezcla
    const both = !!(b && F.inMix);
    const level = both ? splitLevel(m) : CLIP_H;
    auraField(ctx, a.pal, t, 1, a.beat);
    if (both) { ctx.save(); wavePath(ctx, level, t, m, true); ctx.clip(); auraField(ctx, b.pal, t + 4, 1, b.beat); ctx.restore(); }
    ctx.fillStyle = "rgba(0,0,0,.18)"; ctx.fillRect(0, 0, CLIP_W, CLIP_H);
    if (!both) auraRegion(ctx, cur, 0, CLIP_H, t);
    else {
      // Cada mitad nunca se encoge por debajo de un tamaño legible: mientras la frontera se mueve,
      // asoma por detrás de la ola en vez de aplastarse. La de abajo deja sitio a la barra de progreso
      const MIN = 840, bottom = CLIP_H - 150;
      ctx.save(); wavePath(ctx, level, t, m, false); ctx.clip(); auraRegion(ctx, a, Math.min(0, level - MIN), level, t); ctx.restore();
      ctx.save(); wavePath(ctx, level, t, m, true); ctx.clip(); ctx.beginPath(); ctx.rect(0, 0, CLIP_W, bottom - 20); ctx.clip();
      auraRegion(ctx, b, level, Math.max(bottom, level + MIN), t); ctx.restore();
      // Un filo de luz marca la frontera
      ctx.save(); ctx.beginPath(); for (let x = 0; x <= CLIP_W; x += 20) ctx.lineTo(x, waveY(x, level, t, m));
      ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 3; ctx.shadowColor = "#fff"; ctx.shadowBlur = 20; ctx.stroke(); ctx.restore();
    }
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,.25)"; rr(ctx, 120, 1780, 840, 6, 3); ctx.fill();
    ctx.fillStyle = "#fff"; rr(ctx, 120, 1780, 840 * clamp01(cur.pos / cur.length), 6, 3); ctx.fill();
    ctx.font = "700 24px Inter"; ctx.globalAlpha = 0.55; ctx.fillText("MIX BOOTH", CLIP_W / 2, 1850); ctx.globalAlpha = 1;
    addGrain(ctx);
  }
  function fitText(ctx, text, maxW, base, weight = "", family = "Anton") {
    ctx.font = `${weight} ${base}px ${family}`.trim();
    const w = ctx.measureText(text).width;
    const size = Math.max(10, Math.min(base, Math.floor(base * maxW / Math.max(1, w))));
    ctx.font = `${weight} ${size}px ${family}`.trim();
    return size;
  }

  // ----- Estilo Kinetic -----
  const MODES = ["punch", "slideL", "spin", "slideU", "stretch"];
  function kineticWord(ctx, word, k, cx, cy, mode, beat, maxSize = 420, scale = 1) {
    const text = word.toUpperCase();
    // Cabe en 900 px incluso en el momento más ancho de su animación, y no más alto que su franja
    const size = Math.min(maxSize, fitText(ctx, text, mode === "stretch" ? 760 : 900, 420));
    ctx.save(); ctx.font = `${size}px Anton`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff";
    const ghost = (dx, dy, alpha, sc = 1, rot = 0) => { ctx.save(); ctx.globalAlpha = alpha; ctx.translate(cx + dx, cy + dy); ctx.rotate(rot); ctx.scale(sc, sc); ctx.fillText(text, 0, 0); ctx.restore(); };
    if (mode === "punch") ghost(0, 0, clamp01(k * 3), (1.5 - 0.5 * easeBack(k)) * (1 + beat * 0.04));
    else if (mode === "slideL") { const x = (1 - easeOut(k)) * -900; for (let g = 4; g >= 1; g--) ghost(x - g * 60 * (1 - k), 0, 0.12 * (1 - k)); ghost(x, 0, 1); }
    else if (mode === "spin") ghost(0, 0, clamp01(k * 2), 0.6 + 0.4 * easeBack(k), (1 - easeBack(k)) * -0.9);
    else if (mode === "slideU") { const y = (1 - easeOut(k)) * 700 * scale; for (let g = 3; g >= 1; g--) ghost(0, y + g * 50 * scale * (1 - k), 0.15 * (1 - k)); ghost(0, y, 1); }
    else { ctx.save(); ctx.translate(cx, cy); ctx.scale(1 + (1 - easeBack(k)) * 0.3, 0.4 + 0.6 * easeBack(k)); ctx.fillText(text, 0, 0); ctx.restore(); }
    ctx.restore();
  }
  let glitchSnap = null;
  // Una canción dentro de una franja; con la franja entera es el diseño de una sola canción
  // [y0, y1] es donde se coloca todo; [top, bot] es la parte visible (la franja puede asomar recortada)
  function drawKineticScene(ctx, song, t, y0 = 0, y1 = CLIP_H, top = y0, bot = y1) {
    const pal = song.pal, beat = song.beat;
    const h = y1 - y0, sk = h / CLIP_H, cy = y0 + h * 0.51;
    if (bot - top < 4) return;
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, CLIP_W, bot - top); ctx.clip();
    ctx.fillStyle = rgba(mixColor(pal.c[0], [10, 10, 14], 0.15)); ctx.fillRect(0, top, CLIP_W, bot - top);
    ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = rgba(pal.c[1]);
    for (let i = 0; i < 7; i++) { const x = ((i * 220 + t * 180) % (CLIP_W + 400)) - 200; ctx.fillRect(x, top, 60, bot - top); }
    ctx.restore();
    const r = Math.max(110, 330 * sk) + beat * 26 * Math.max(sk, 0.5), img = Math.max(240, 720 * sk);
    if (song.img) { ctx.save(); ctx.beginPath(); ctx.arc(CLIP_W / 2, cy, r, 0, 7); ctx.clip(); ctx.drawImage(song.img, CLIP_W / 2 - img / 2, cy - img / 2, img, img); ctx.restore(); }
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(CLIP_W / 2, cy, r + 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ((t % 4) / 4)); ctx.stroke();
    // La palabra que suena, gigante, con su animación de entrada
    const line = song.line;
    let word = null, k = 1, mode = "punch";
    if (line) {
      let wi = -1; line.words.forEach((w, i) => { if (song.pos >= w.start - 60) wi = i; });
      if (wi >= 0) { const w = line.words[wi]; word = w.text; k = clamp01((song.pos - w.start + 60) / 320); mode = MODES[(Math.round(line.start / 997) + wi) % MODES.length]; }
    } else if (!song.hasLyrics) { const words = song.title.split(" "); const i = Math.floor(t / 0.9) % words.length; word = words[i]; k = clamp01((t % 0.9) / 0.32); mode = MODES[i % MODES.length]; }
    if (word) { ctx.globalCompositeOperation = "difference"; kineticWord(ctx, word, k, CLIP_W / 2, cy, mode, beat, Math.max(150, h * 0.42), sk); ctx.globalCompositeOperation = "source-over"; }
    ctx.textAlign = "left"; ctx.fillStyle = "#fff";
    const titleY = y0 + Math.max(64, 140 * sk);
    ctx.globalAlpha = 0.9; fitText(ctx, song.title, 900, Math.round(Math.max(28, 34 * sk)), "800", "Inter"); ctx.fillText(song.title, 70, titleY);
    ctx.globalAlpha = 0.65; ctx.font = `600 ${Math.round(Math.max(22, 30 * sk))}px Inter`; ctx.fillText(song.artist + (song.bpm ? ` — ${song.bpm} BPM` : ""), 70, titleY + Math.max(34, 46 * sk)); ctx.globalAlpha = 1;
    if (line) { const text = line.words.map((w) => w.text).join(" ").toUpperCase(); ctx.textAlign = "center"; ctx.globalAlpha = 0.85; fitText(ctx, text, 940, Math.round(Math.max(26, 40 * sk)), "700", "Inter"); ctx.fillText(text, CLIP_W / 2, y0 + h * 0.86); ctx.globalAlpha = 1; }
    ctx.restore();
  }
  function drawKinetic(ctx, F) {
    const { m, a, b, cur, now: t } = F;
    // Durante la mezcla la pantalla se parte: la canción que sale arriba y la que entra abajo, cada una
    // con su palabra al ritmo de su letra. La frontera sube según avanza la mezcla y salta con cada beat
    const both = !!(b && F.inMix);
    if (!both) drawKineticScene(ctx, cur, t);
    else {
      const level = splitLevel(m);
      const MIN = 860;
      drawKineticScene(ctx, a, t, Math.min(0, level - MIN), level, 0, level);
      drawKineticScene(ctx, b, t, level, Math.max(CLIP_H, level + MIN), level, CLIP_H);
      // Glitch en la frontera: franjas desplazadas y separación de colores en cada golpe
      const hit = Math.max(a.beat, b.beat);
      // Se crea una vez; cambiarle el tamaño en cada cuadro reservaría 8 MB nuevos cada vez
      if (!glitchSnap) { glitchSnap = document.createElement("canvas"); glitchSnap.width = CLIP_W; glitchSnap.height = CLIP_H; }
      const snap = glitchSnap.getContext("2d"); snap.clearRect(0, 0, CLIP_W, CLIP_H); snap.drawImage(ctx.canvas, 0, 0);
      const seed = Math.floor(t * 24);
      for (let i = 0; i < 6; i++) {
        // Pegado a la línea, sin llegar al título de la canción de abajo
        const y = level - 34 + ((seed * 53 + i * 37) % 50), hh = 6 + ((seed + i * 5) % 4) * 5, dx = (((seed * 13 + i * 31) % 21) - 10) * 9 * hit;
        ctx.drawImage(glitchSnap, 0, y, CLIP_W, hh, dx, y, CLIP_W, hh);
      }
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.25 * hit; ctx.drawImage(glitchSnap, 0, level - 30, CLIP_W, 54, 14 * hit, level - 30, CLIP_W, 54); ctx.restore();
      ctx.fillStyle = "#fff"; ctx.fillRect(0, level - 3, CLIP_W, 6);
    }
    ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = "800 24px Inter"; ctx.globalAlpha = 0.5; ctx.fillText("MIX BOOTH", CLIP_W / 2, 1850); ctx.globalAlpha = 1;
    addGrain(ctx);
  }

  // ----- Estilo Orbit (3D) -----
  // Cada canción es un pequeño espacio en 3D (portada, halo, título y letra) y una cámara lo recorre.
  // Al empezar la mezcla la cámara se aleja hasta encuadrar las dos (una encima de otra), las mantiene
  // mientras suenan juntas girando despacio, y al acabar baja a la nueva. Termina con el mismo encuadre
  // con el que muestra una canción sola, así que no hay salto. Lo dibuja WebGL en un lienzo aparte
  const ORBIT = { a: [0, 8.5, 0], b: [0, -9.5, -3] };
  let orbitGL;
  function orbitEngine() {
    if (orbitGL !== undefined) return orbitGL;
    orbitGL = null;
    const canvas = document.createElement("canvas"); canvas.width = CLIP_W; canvas.height = CLIP_H;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: true });
    if (!gl) return null;
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, "attribute vec2 p; uniform mat4 mvp; uniform vec2 uvs; varying vec2 uv; varying float d; void main(){ uv = (p + 0.5) * uvs; vec4 q = mvp * vec4(p, 0.0, 1.0); d = q.w; gl_Position = q; }"));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, "precision mediump float; varying vec2 uv; varying float d; uniform sampler2D tex; uniform vec4 tint; void main(){ vec4 c = texture2D(tex, uv) * tint; float fog = 1.0 - clamp((d - 14.0) / 61.0, 0.0, 1.0); gl_FragColor = vec4(c.rgb, c.a * fog); }"));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    const locP = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(locP); gl.vertexAttribPointer(locP, 2, gl.FLOAT, false, 0, 0);
    const U = {}; for (const n of ["mvp", "tex", "tint", "uvs"]) U[n] = gl.getUniformLocation(prog, n);
    gl.enable(gl.BLEND);
    // Los lienzos 2D tienen el eje vertical al revés que WebGL
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const texture = (src, repeat = false) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE; gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      if (src) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      return t;
    };
    const paint = (w, h, draw) => { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d")); return c; };
    const glow = (stop) => (x) => { const g = x.createRadialGradient(128, 128, 0, 128, 128, 128); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(stop, "rgba(255,255,255,.4)"); g.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = g; x.fillRect(0, 0, 256, 256); };
    orbitGL = {
      canvas, gl, U, texture,
      upload(t, src) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); },
      paint,
      glow: texture(paint(256, 256, glow(0.35))),
      dot: texture(paint(256, 256, glow(0.3))),
      grid: texture(paint(256, 256, (x) => { x.strokeStyle = "rgba(255,255,255,.55)"; x.lineWidth = 3; x.strokeRect(0, 0, 256, 256); }), true),
      songs: new Map(),
      parts: Array.from({ length: 220 }, (_, i) => ({ x: ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 40 - 20, y: ((Math.sin(i * 78.233) * 12345.678) % 1) * 40 - 20, z: (i / 220) * -110 + 30, side: i % 2, s: 0.15 + (i % 5) * 0.06 })),
    };
    return orbitGL;
  }
  // Matrices 4x4 por columnas
  const m4 = {
    mul(a, b) { const o = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; },
    persp(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]); },
    look(e, c, up) {
      const sub = [e[0] - c[0], e[1] - c[1], e[2] - c[2]];
      const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
      const crs = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
      const dt = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
      const z = nrm(sub), x = nrm(crs(up, z)), y = crs(z, x);
      return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dt(x, e), -dt(y, e), -dt(z, e), 1]);
    },
    // Trasladar, girar en Y y en X, y escalar (ancho, alto). Escribe en `o` para no crear matrices nuevas
    // en cada cuadro (cientos por cuadro harían que el navegador parase a limpiar memoria: tirones)
    modelInto(o, px, py, pz, ry, rx, sx, sy) {
      const cy = Math.cos(ry), sY = Math.sin(ry), cx = Math.cos(rx), sX = Math.sin(rx);
      o[0] = cy * sx; o[1] = 0; o[2] = -sY * sx; o[3] = 0;
      o[4] = sY * sX * sy; o[5] = cx * sy; o[6] = cy * sX * sy; o[7] = 0;
      o[8] = sY * cx; o[9] = -sX; o[10] = cy * cx; o[11] = 0;
      o[12] = px; o[13] = py; o[14] = pz; o[15] = 1;
      return o;
    },
    mulInto(o, a, b) {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; }
      return o;
    },
  };
  const orbitModel = new Float32Array(16), orbitMVP = new Float32Array(16);
  // Lo de cada canción en la GPU: portada, título y letra (la letra se repinta cada cuadro, con las palabras que ya sonaron encendidas)
  function orbitSong(E, song) {
    const key = song.uri || `${song.title}|${song.artist}`;
    let s = E.songs.get(key);
    if (!s) {
      s = { cover: E.texture(null), coverFrom: undefined, title: E.texture(null), titleKey: "", lyric: E.texture(null), lyricCanvas: E.paint(1024, 512, () => {}), titleCanvas: E.paint(1024, 256, () => {}) };
      E.songs.set(key, s);
      if (E.songs.size > 6) { const [old, o] = E.songs.entries().next().value; for (const t of [o.cover, o.title, o.lyric]) E.gl.deleteTexture(t); E.songs.delete(old); }
    }
    const accent = song.pal.c[1] ?? song.pal.c[0];
    if (s.coverFrom !== song.img) {
      s.coverFrom = song.img;
      // Sin portada todavía: un degradado con sus colores
      const c = E.paint(1024, 1024, (x) => {
        x.beginPath(); x.roundRect(8, 8, 1008, 1008, 70); x.clip();
        if (song.img) x.drawImage(song.img, 0, 0, 1024, 1024);
        else { const g = x.createLinearGradient(0, 0, 1024, 1024); g.addColorStop(0, rgba(song.pal.c[0])); g.addColorStop(1, rgba(song.pal.c[2] ?? song.pal.deep)); x.fillStyle = g; x.fillRect(0, 0, 1024, 1024); }
        const g = x.createLinearGradient(0, 0, 1024, 1024); g.addColorStop(0, "rgba(255,255,255,.25)"); g.addColorStop(0.45, "rgba(255,255,255,0)"); x.fillStyle = g; x.fillRect(0, 0, 1024, 1024);
      });
      try { E.upload(s.cover, c); } catch {}
    }
    const titleKey = `${song.title}|${song.artist}|${song.bpm}|${accent}`;
    if (s.titleKey !== titleKey) {
      s.titleKey = titleKey;
      const x = s.titleCanvas.getContext("2d"); x.clearRect(0, 0, 1024, 256); x.textAlign = "center";
      x.fillStyle = "#fff"; fitText(x, song.title.toUpperCase(), 980, 64, "", "Anton"); x.fillText(song.title.toUpperCase(), 512, 110);
      x.fillStyle = rgba(accent); x.font = "700 40px Inter"; x.fillText(`${song.artist.toUpperCase()}${song.bpm ? `  ·  ${song.bpm} BPM` : ""}`, 512, 175);
      E.upload(s.title, s.titleCanvas);
    }
    // La letra solo se repinta y se sube a la GPU cuando cambia algo visible (una palabra se enciende un poco más)
    const line = song.line;
    let lyricKey = `${accent}`;
    if (line) { lyricKey += `|${line.start}|`; for (const w of line.words) lyricKey += Math.round(clamp01((song.pos - w.start) / Math.max(1, w.end - w.start)) * 6); }
    if (lyricKey === s.lyricKey) return s;
    s.lyricKey = lyricKey;
    const x = s.lyricCanvas.getContext("2d"); x.clearRect(0, 0, 1024, 512);
    if (line) {
      x.font = "900 92px Inter"; x.textBaseline = "alphabetic"; x.textAlign = "left";
      const sp = x.measureText(" ").width * 1.3, rows = [[]]; let lw = 0;
      for (const w of line.words) { const ww = x.measureText(w.text).width; if (lw + ww > 960 && rows[rows.length - 1].length) { rows.push([]); lw = 0; } rows[rows.length - 1].push(w); lw += ww + sp; }
      rows.slice(0, 3).forEach((row, r) => {
        const total = row.reduce((sum, w) => sum + x.measureText(w.text).width, 0) + sp * (row.length - 1);
        let px = 512 - total / 2; const py = 140 + r * 120;
        for (const w of row) {
          const ww = x.measureText(w.text).width, k = Math.round(clamp01((song.pos - w.start) / Math.max(1, w.end - w.start)) * 6) / 6;
          x.fillStyle = "rgba(255,255,255,.28)"; x.fillText(w.text, px, py);
          if (k > 0) { x.save(); x.beginPath(); x.rect(px - 6, py - 100, (ww + 12) * k, 140); x.clip(); x.shadowColor = rgba(accent); x.shadowBlur = 28; x.fillStyle = "#fff"; x.fillText(w.text, px, py); x.restore(); }
          px += ww + sp;
        }
      });
    }
    E.upload(s.lyric, s.lyricCanvas);
    return s;
  }
  function drawOrbit(ctx, F) {
    const E = orbitEngine();
    if (!E) { drawAura(ctx, F); return; }
    const { gl, U } = E, t = F.now;
    const both = !!(F.b && F.inMix), m = both ? F.m : 0;
    const A = both ? F.a : F.cur, B = both ? F.b : null;
    const wa = ORBIT.a, wb = ORBIT.b;
    // Abrir (al empezar), mantener las dos, y cerrar en la nueva
    const into = both ? smoothStep(m / 0.2) : 0, outOf = both ? smoothStep((m - 0.8) / 0.2) : 0, hold = into * (1 - outOf);
    const rush = Math.sin(into * Math.PI) + Math.sin(outOf * Math.PI);
    const beat = B ? A.beat + (B.beat - A.beat) * outOf : A.beat;
    const lerp = (p, q, k) => p + (q - p) * k;
    const center = [0, 1, 2].map((i) => (wa[i] + wb[i]) / 2);
    const look = [0, 1, 2].map((i) => lerp(lerp(wa[i], center[i], into), wb[i], outOf) + (i === 1 ? 0.3 + hold * 1.6 : 0));
    const dist = 21 + hold * 13;
    const yaw = Math.sin(smoothStep((m - 0.1) / 0.8) * Math.PI) * 0.25 + Math.sin(t * 0.3) * 0.07;
    const eye = [look[0] + Math.sin(yaw) * dist, look[1] + 1.2 - hold * 1.2 + Math.sin(t * 0.5) * 0.4, look[2] + Math.cos(yaw) * dist];
    const roll = hold * 0.06 * Math.sin(t * 0.4);
    const fov = ((52 - beat * 0.7 + hold * 8) * Math.PI) / 180;
    const VP = m4.mul(m4.persp(fov, CLIP_W / CLIP_H, 0.1, 200), m4.look(eye, look, [Math.sin(roll), Math.cos(roll), 0]));
    gl.viewport(0, 0, CLIP_W, CLIP_H);
    const deepA = A.pal.deep, deepB = B ? B.pal.deep : deepA;
    gl.clearColor(...deepA.map((v, i) => (lerp(v, deepB[i], outOf) / 255) * 0.6), 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0); gl.uniform1i(U.tex, 0);
    // Dibuja un rectángulo sin crear nada nuevo: la matriz se escribe en las mismas dos de siempre
    const quad = (tex, px, py, pz, ry, rx, sx, sy, c, a, additive, rep = 1) => {
      gl.blendFunc(gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(U.mvp, false, m4.mulInto(orbitMVP, VP, m4.modelInto(orbitModel, px, py, pz, ry, rx, sx, sy)));
      if (c) gl.uniform4f(U.tint, c[0] / 255, c[1] / 255, c[2] / 255, a); else gl.uniform4f(U.tint, 1, 1, 1, a);
      gl.uniform2f(U.uvs, rep, rep);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    // Suelo de rejilla, siempre a la misma altura bajo lo que se mira
    const floor = B ? A.pal.c[0].map((v, i) => lerp(v, B.pal.c[0][i], outOf)) : A.pal.c[0];
    quad(E.grid, look[0], look[1] - 14.5, look[2] - 10, 0, -Math.PI / 2, 160, 160, floor, 0.4, true, 40);
    // Partículas que vienen hacia la cámara; al abrir y al cerrar la mezcla van a toda velocidad.
    // Las de detrás de las portadas se pintan antes que ellas, y las de delante, después
    const speed = 3 + hold * 5 + rush * 26, span = 120, split = eye[2] - dist + 2;
    const particles = (front) => {
      for (const p of E.parts) {
        const zz = ((((p.z + t * speed) % span) + span) % span) + eye[2] - span;
        if ((zz > split) !== front) continue;
        const c = (p.side && B ? B : A).pal.c[(p.side * 2 + ((p.s * 10) | 0)) % 4] ?? A.pal.c[0];
        quad(E.dot, eye[0] + p.x, eye[1] + p.y, zz, 0, 0, p.s, p.s * (1 + rush * 3), c, 0.9, true);
      }
    };
    particles(false);
    // Cada mundo: primero sus halos (se suman, el orden da igual) y luego portada, título y letra, de lejos a cerca
    const worlds = [];
    const world = (song, pos, vis) => {
      if (!song || vis <= 0.01) return;
      const s = orbitSong(E, song), [px, py, pz] = pos, bs = 1 + song.beat * 0.025;
      quad(E.glow, px, py, pz - 2, 0, 0, 26 * bs, 26 * bs, song.pal.c[0], 0.55 * vis, true);
      quad(E.glow, px + 4, py + 3, pz - 4, 0, 0, 18, 18, song.pal.c[1] ?? song.pal.c[0], 0.35 * vis, true);
      worlds.push({ s, px, py, pz, bs, vis, d: Math.hypot(px - eye[0], py - eye[1], pz - eye[2]) });
    };
    // Sola, la canción está donde la cámara la espera; en la mezcla, la que sale arriba y la que entra abajo.
    // Al terminar la mezcla la nueva queda en el mismo sitio relativo que la de antes, así que no hay salto
    if (!B) world(A, wa, 1);
    else { world(A, wa, 1 - smoothStep((m - 0.85) / 0.15)); world(B, wb, smoothStep(m / 0.12)); }
    worlds.sort((p, q) => q.d - p.d);
    const face = (qx, qz) => Math.atan2(eye[0] - qx, eye[2] - qz) * 0.75;
    for (const { s, px, py, pz, bs, vis } of worlds) {
      quad(s.cover, px, py + 1.2 + Math.sin(t * 1.1) * 0.15, pz, Math.sin(t * 0.8) * 0.08, Math.sin(t * 0.6) * 0.05, 7 * bs, 7 * bs, null, vis, false);
      quad(s.title, px, py + 6, pz + 0.5, face(px, pz), 0, 8, 2, null, vis, false);
      quad(s.lyric, px, py - 5, pz + 2.2, face(px, pz + 2.2), 0.06, 10, 5, null, vis, false);
    }
    particles(true);
    ctx.drawImage(E.canvas, 0, 0, CLIP_W, CLIP_H);
    const v = ctx.createRadialGradient(CLIP_W / 2, CLIP_H / 2, CLIP_H * 0.3, CLIP_W / 2, CLIP_H / 2, CLIP_H * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.55)"); ctx.fillStyle = v; ctx.fillRect(0, 0, CLIP_W, CLIP_H);
    if (hold > 0) { ctx.fillStyle = `rgba(255,255,255,${(hold * beat * 0.07).toFixed(3)})`; ctx.fillRect(0, 0, CLIP_W, CLIP_H); }
    // Cabecera de mezcla: de qué canción a cuál, y cuánto lleva
    const hud = both ? smoothStep(m / 0.1) * (1 - smoothStep((m - 0.9) / 0.1)) : 0;
    if (hud > 0) {
      ctx.save(); ctx.globalAlpha = hud; ctx.textAlign = "center"; ctx.fillStyle = "#fff";
      ctx.font = "800 30px Inter"; ctx.fillText("MIXING", CLIP_W / 2, 120);
      ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.font = "700 26px Inter";
      const left = A.title.toUpperCase(), right = B.title.toUpperCase();
      ctx.textAlign = "right"; fitText(ctx, left, 420, 26, "700", "Inter"); ctx.fillText(left, CLIP_W / 2 - 40, 170);
      ctx.textAlign = "left"; fitText(ctx, right, 420, 26, "700", "Inter"); ctx.fillText(right, CLIP_W / 2 + 40, 170);
      ctx.textAlign = "center"; ctx.font = "700 26px Inter"; ctx.fillText("→", CLIP_W / 2, 170);
      ctx.fillStyle = "rgba(255,255,255,.2)"; ctx.fillRect(240, 200, 600, 4);
      const g = ctx.createLinearGradient(240, 0, 840, 0); g.addColorStop(0, rgba(A.pal.c[0])); g.addColorStop(1, rgba(B.pal.c[0]));
      ctx.fillStyle = g; ctx.fillRect(240, 200, 600 * m, 4);
      ctx.restore();
    }
    ctx.textAlign = "center"; ctx.font = "800 24px Inter"; ctx.fillStyle = "rgba(255,255,255,.45)"; ctx.fillText("MIX BOOTH", CLIP_W / 2, CLIP_H - 60);
  }

  // ----- Letra al estilo de Spicy Lyrics -----
  // Varias líneas a la izquierda: la anterior apagada arriba, la que suena brillante y las siguientes debajo.
  // En la que suena, cada palabra se rellena de luz de izquierda a derecha mientras se canta, sube un poco y
  // brilla; las demás líneas se ven tenues y algo desenfocadas según lo lejos que están. Al pasar de línea la
  // lista sube con suavidad. En las partes sin letra, tres puntos que laten
  function spicyLyrics(ctx, song, X, Y, maxW, size, rowsBelow, alpha = 1) {
    const lines = song.lines;
    if (!lines?.length || alpha <= 0.01) return;
    const pos = song.pos, lh = size * 1.18;
    ctx.save(); ctx.font = `800 ${size}px Inter`; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    const sp = ctx.measureText(" ").width;
    // Cada línea partida en filas que caben en el ancho
    const layout = (line) => {
      if (line.rows) return line.rows;
      const rows = [[]]; let w = 0;
      for (const word of line.words) { const ww = ctx.measureText(word.text).width; if (w + ww > maxW && rows[rows.length - 1].length) { rows.push([]); w = 0; } rows[rows.length - 1].push({ word, ww }); w += ww + sp; }
      return rows;
    };
    let idx = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].start <= pos + 150) idx = i; else break; }
    // Desplazamiento suave: durante 450 ms tras empezar la línea, la lista sube desde la anterior
    const settle = idx >= 0 ? smoothStep((pos - lines[idx].start + 150) / 450) : 1;
    const first = Math.max(0, idx - 1), last = Math.min(lines.length - 1, Math.max(idx, 0) + rowsBelow);
    const heights = [];
    for (let i = first; i <= last; i++) heights[i] = layout(lines[i]).length * lh + size * 0.35;
    // Posición de la línea actual: arriba del bloque, dejando sitio a la anterior
    const prevH = idx > 0 ? heights[idx - 1] ?? lh : 0;
    let y = Y - (idx > 0 ? prevH : 0) + (1 - settle) * (idx > 0 ? prevH : 0);
    const bottom = Y + lh * (rowsBelow + 1.3);
    // La letra no sale de su franja: al subir, la línea anterior se mete por arriba, y las de abajo no tocan nada
    ctx.beginPath(); ctx.rect(X - 60, Y - size * 0.3, maxW + 160, bottom - Y + size * 2); ctx.clip();
    for (let i = first; i <= last; i++) {
      const line = lines[i], rows = layout(line), dist = i - idx;
      const active = i === idx && pos <= line.end + 400;
      // Las líneas lejanas se apagan y se desenfocan; la anterior se va desvaneciendo al subir
      let a = active ? 1 : i < idx ? 0.32 * (1 - settle) : Math.max(0.12, 0.42 - (dist - 1) * 0.12);
      if (y + rows.length * lh > bottom + lh) a *= 0.4;
      if (y > bottom) break;
      const blur = active ? 0 : Math.min(5, Math.abs(dist) * 2.2);
      ctx.globalAlpha = alpha * a;
      ctx.filter = blur > 0.3 ? `blur(${blur.toFixed(1)}px)` : "none";
      rows.forEach((row, r) => {
        let px = X;
        const py = y + size + r * lh;
        // Abajo solo entran filas enteras: nada de líneas cortadas por la mitad
        if (py > bottom + size * 0.2) return;
        for (const { word, ww } of row) {
          const k = active ? clamp01((pos - word.start) / Math.max(1, word.end - word.start)) : i < idx ? 1 : 0;
          if (!active) { ctx.fillStyle = "#fff"; ctx.fillText(word.text, px, py); px += ww + sp; continue; }
          // Relleno de luz que avanza por la palabra, con el borde suave
          const lift = -size * 0.06 * Math.sin(Math.PI * Math.min(1, k * 1.15)) - (k >= 1 ? size * 0.015 : 0);
          const g = ctx.createLinearGradient(px, 0, px + ww, 0);
          g.addColorStop(0, k > 0 ? "rgba(255,255,255,1)" : "rgba(255,255,255,.38)");
          g.addColorStop(clamp01(k - 0.08), k > 0 ? "rgba(255,255,255,1)" : "rgba(255,255,255,.38)");
          g.addColorStop(clamp01(k + 0.08), "rgba(255,255,255,.38)");
          g.addColorStop(1, k >= 1 ? "rgba(255,255,255,1)" : "rgba(255,255,255,.38)");
          ctx.save();
          if (k > 0 && k < 1) { ctx.shadowColor = "rgba(255,255,255,.75)"; ctx.shadowBlur = size * 0.35; }
          else if (k >= 1) { ctx.shadowColor = "rgba(255,255,255,.35)"; ctx.shadowBlur = size * 0.18; }
          ctx.fillStyle = g; ctx.fillText(word.text, px, py + lift);
          ctx.restore();
          px += ww + sp;
        }
      });
      y += heights[i] ?? rows.length * lh;
    }
    ctx.filter = "none";
    // Sin letra ahora mismo (intro o parte instrumental larga): tres puntos que laten
    const next = lines[idx + 1], current = lines[idx];
    const gap = (!current || pos > current.end + 600) && (!next || next.start - pos > 1500);
    if (gap) {
      ctx.globalAlpha = alpha;
      for (let d = 0; d < 3; d++) {
        const ph = (pos / 1000) * 2.2 - d * 0.35, s = 0.6 + 0.4 * Math.max(0, Math.sin(ph * Math.PI));
        ctx.fillStyle = `rgba(255,255,255,${(0.35 + 0.65 * Math.max(0, Math.sin(ph * Math.PI))).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(X + size * 0.3 + d * size * 0.75, Y + size * 0.6, size * 0.16 * s, 0, 7); ctx.fill();
      }
    }
    ctx.restore();
  }

  // ----- Estilo Waveform -----
  // La forma de onda de cada canción (barras finas sobre una línea discontinua) vista muy de lado y de cerca:
  // las barras pasan rozando la cámara y se pierden en diagonal. Lo que ya sonó va del color de la canción.
  // En la mezcla las dos ondas se juntan en el centro, la nueva un poco delante y más abajo; donde se pisan,
  // sus colores se mezclan. Las barras salen del volumen real de cada tramo de la canción
  const WAVE_MS = 45, WAVE_GAP = 0.105;
  const WAVE_DUST = Array.from({ length: 140 }, (_, i) => ({ x: (Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1) * 36 - 18, y: (Math.abs(Math.sin(i * 78.233) * 12345.678) % 1) * 16 - 8, z: (Math.abs(Math.sin(i * 39.425) * 24634.6345) % 1) * 18 - 12, s: 0.02 + (i % 4) * 0.012, ph: i * 0.7 }));
  const waveHash = (n, seed) => Math.abs(Math.sin(n * 12.9898 + seed) * 43758.5453) % 1;
  // Volumen (0 a 1) de la canción en un momento: del análisis de audio si lo hay; si no, una onda inventada estable
  function waveLevel(song, ms, seed) {
    const segs = song.segs, bar = Math.floor(ms / WAVE_MS);
    let v;
    if (segs?.length) {
      let lo = 0, hi = segs.length - 1, i = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].at <= ms) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      if (i < 0) return 0.05;
      v = clamp01((segs[i].loud + 32) / 30) ** 1.4;
    } else {
      const x = ms / 1000;
      v = clamp01(0.5 + 0.25 * Math.sin(x * 1.7 + seed) + 0.15 * Math.sin(x * 5.3 + seed * 2) + 0.1 * Math.sin(x * 11.1 + seed * 3));
    }
    return clamp01(v * (0.5 + 0.5 * waveHash(bar, seed)));
  }
  function drawWaveform(ctx, F) {
    const t = F.now, W = CLIP_W, H = CLIP_H;
    const both = !!(F.b && F.inMix), m = both ? F.m : 0;
    const A = both ? F.a : F.cur, B = both ? F.b : null;
    const lerp = (p, q, k) => p + (q - p) * k;
    const mixC = (p, q, k) => p.map((v, i) => lerp(v, q[i], k));
    const seedOf = (s) => { let h = 0; for (const ch of s.uri || s.title) h = (h * 31 + ch.charCodeAt(0)) % 1000; return h / 100; };
    const into = smoothStep(m / 0.2), outOf = smoothStep((m - 0.8) / 0.2), hold = into * (1 - outOf);
    const growB = B ? smoothStep(m / 0.18) : 0, shrinkA = B ? smoothStep((m - 0.8) / 0.17) : 0;
    // Dónde termina la que sale y dónde empezó la que entra (en el tiempo de cada una)
    const aEnd = B ? A.pos + (1 - m) * (F.dur || 1) : Infinity, bStart = B ? B.pos - m * (F.dur || 1) : -Infinity;
    const yA = 0.45 * into, yB = -0.45 * (1 - outOf), zA = -0.5 * into, zB = 0.6 * (1 - outOf);
    const target = [0, (yA * (1 - shrinkA) + yB * growB) / ((1 - shrinkA) + growB || 1) - 0.3, 0];
    // Cámara cerca y muy de lado; gira un poco, despacio
    const ang = -1.2 + Math.sin(t * 0.17) * 0.1 + Math.sin(smoothStep((m - 0.1) / 0.8) * Math.PI) * 0.12;
    const R = 6.2 + hold * 0.8, hgt = 0.9 + Math.sin(t * 0.3) * 0.25;
    const eye = [target[0] + Math.sin(ang) * R, target[1] + hgt, target[2] + Math.cos(ang) * R];
    const sub = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const crs = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const fwd = nrm(sub), right = nrm(crs(fwd, [Math.sin(Math.sin(t * 0.25) * 0.04), 1, 0])), up = crs(right, fwd);
    const f = H / 2 / Math.tan((55 * Math.PI) / 360), cx = W / 2, cy = H / 2;
    const proj = (x, y, z) => {
      const dx = x - eye[0], dy = y - eye[1], dz = z - eye[2];
      const Z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
      if (Z < 0.4) return null;
      return [cx + ((dx * right[0] + dy * right[1] + dz * right[2]) * f) / Z, cy - ((dx * up[0] + dy * up[1] + dz * up[2]) * f) / Z, Z];
    };
    // Fondo con el color de las dos canciones según cuánto suena cada una, y un halo de cada una detrás de su onda
    const deep = B ? mixC(A.pal.deep, B.pal.deep, lerp(growB * 0.5, 1, outOf)) : A.pal.deep;
    const g0 = ctx.createLinearGradient(0, 0, 0, H);
    g0.addColorStop(0, "#000"); g0.addColorStop(0.5, rgba(mixC(deep, [255, 255, 255], 0.04))); g0.addColorStop(1, "#000");
    ctx.fillStyle = g0; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "screen";
    const halo = (song, x, y, a) => {
      if (!song || a <= 0.01) return; const p = proj(x, y, -3); if (!p) return;
      const r = (10 * f) / p[2], g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
      g.addColorStop(0, rgba(song.pal.c[0], 0.3 * a)); g.addColorStop(1, rgba(song.pal.c[0], 0)); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    };
    halo(A, -2 * into, yA, 1 - shrinkA); halo(B, 2 * growB * (1 - outOf), yB, growB);
    ctx.globalCompositeOperation = "source-over";
    const dust = (front) => {
      for (const d of WAVE_DUST) {
        if ((d.z > -2) !== front) continue;
        const p = proj(d.x + Math.sin(t * 0.3 + d.ph) * 0.4, d.y + target[1] + Math.sin(t * 0.5 + d.ph) * 0.3, d.z); if (!p) continue;
        ctx.fillStyle = `rgba(255,255,255,${((0.25 + 0.35 * Math.sin(t * 1.3 + d.ph) ** 2) * clamp01(1.3 - p[2] / 30)).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(0.8, (d.s * f) / p[2]), 0, 7); ctx.fill();
      }
    };
    dust(false);
    // Línea discontinua, brillo de la base y una marca en cada beat (de la canción que manda)
    const baseline = (song, y, z, a, marks, from, to) => {
      if (!song || a <= 0.01) return;
      ctx.strokeStyle = `rgba(255,255,255,${(0.35 * a).toFixed(3)})`;
      for (let x = -34; x < 34; x += 0.5) { const p = proj(x, y, z), q = proj(x + 0.25, y, z); if (!p || !q) continue; ctx.lineWidth = Math.max(1, (0.05 * f) / p[2]); ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); }
      const p = proj(-20, y, z), q = proj(20, y, z);
      if (p && q) { const g = ctx.createLinearGradient(p[0], p[1], q[0], q[1]); g.addColorStop(0, rgba(song.pal.c[0], 0)); g.addColorStop(0.5, rgba(song.pal.c[0], 0.35 * a)); g.addColorStop(1, rgba(song.pal.c[0], 0)); ctx.strokeStyle = g; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); }
      if (marks <= 0.01) return;
      const beats = song.beats?.length ? song.beats : null, beatMs = 60000 / (song.bpm || 120);
      const list = beats ? beats.filter((ms) => ms > song.pos - 7000 && ms < song.pos + 7000) : Array.from({ length: Math.ceil(14000 / beatMs) }, (_, k) => (Math.ceil((song.pos - 7000) / beatMs) + k) * beatMs);
      list.forEach((ms, k) => {
        if (ms < from || ms > to) return;
        const x = ((ms - song.pos) / WAVE_MS) * WAVE_GAP, big = k % 4 === 0;
        const t1 = proj(x, y - 1.0, z + 0.25), t2 = proj(x, y - (big ? 1.25 : 1.12), z + 0.25); if (!t1 || !t2) return;
        ctx.strokeStyle = `rgba(255,255,255,${((big ? 0.55 : 0.3) * marks).toFixed(3)})`; ctx.lineWidth = Math.max(1, (0.03 * f) / t1[2]); ctx.beginPath(); ctx.moveTo(t1[0], t1[1]); ctx.lineTo(t2[0], t2[1]); ctx.stroke();
      });
    };
    baseline(A, yA, zA, 1 - smoothStep((m - 0.9) / 0.1), 1 - growB, -Infinity, aEnd);
    baseline(B, yB, zB, smoothStep(m / 0.08), growB, bStart, Infinity);
    // Las barras de las dos ondas, de lejos a cerca, en modo "pantalla" para que donde se pisan se mezclen los colores
    const bars = [];
    const track = (song, y, z, grow, from, to) => {
      if (!song || grow <= 0.005) return;
      const seed = seedOf(song), n0 = Math.floor((song.pos - 7500) / WAVE_MS), n1 = Math.ceil((song.pos + 7500) / WAVE_MS);
      for (let n = n0; n <= n1; n++) {
        const ms = n * WAVE_MS;
        if (ms < from || ms > to) continue;                 // antes de empezar o después de acabar: solo la línea
        const dist = (ms - song.pos) / 1000;
        const glow = Math.exp(-(dist * dist) / 0.04), played = clamp01(0.5 - dist * 8);
        // Al crecer o encogerse en la mezcla, las barras cercanas al ahora van primero
        const g = clamp01(grow * 1.6 - Math.abs(dist) * 0.06);
        if (g <= 0) continue;
        const h = (0.06 + waveLevel(song, ms, seed) * lerp(1.45, 1.2, hold) * (1 + glow * song.beat * 0.25)) * smoothStep(g);
        const x = ((ms - song.pos) / WAVE_MS) * WAVE_GAP, p = proj(x, y, z);
        if (p) bars.push({ x, y, z, h, song, played, glow, d: p[2], alpha: 0.35 + 0.65 * g });
      }
    };
    track(A, yA, zA, 1 - shrinkA, -Infinity, aEnd);
    track(B, yB, zB, growB, bStart, Infinity);
    bars.sort((p, q) => q.d - p.d);
    ctx.lineCap = "butt"; ctx.globalCompositeOperation = "screen";
    for (const b of bars) {
      const top = proj(b.x, b.y + b.h / 2, b.z), bot = proj(b.x, b.y - b.h / 2, b.z);
      if (!top || !bot) continue;
      const wpx = Math.max(0.9, (0.045 * f) / b.d);
      const col = mixC(mixC([255, 255, 255], b.song.pal.c[0], b.played), [255, 255, 255], b.glow * 0.7);
      const a = b.alpha * lerp(0.35, 1, Math.max(b.played, b.glow)) * clamp01(1.4 - b.d / 40);
      if (b.glow > 0.05 || b.played > 0.5) { ctx.strokeStyle = rgba(col, (0.08 + b.glow * 0.25) * a); ctx.lineWidth = wpx * 3; ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(bot[0], bot[1]); ctx.stroke(); }
      ctx.strokeStyle = rgba(col, a); ctx.lineWidth = wpx; ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(bot[0], bot[1]); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    // Línea del ahora: una luz vertical que atraviesa las ondas
    const topY = B ? lerp(yA, yB, shrinkA) : yA, botY = B ? lerp(yA, yB, growB) : yA;
    const nowTop = proj(0, Math.max(topY, botY) + 1.05, 0), nowBot = proj(0, Math.min(topY, botY) - 1.05, 0);
    if (nowTop && nowBot) {
      const accent = B ? mixC(A.pal.c[1] ?? A.pal.c[0], B.pal.c[1] ?? B.pal.c[0], lerp(into * 0.5, 1, outOf)) : A.pal.c[1] ?? A.pal.c[0];
      ctx.strokeStyle = rgba(accent, 0.18); ctx.lineWidth = 18; ctx.beginPath(); ctx.moveTo(nowTop[0], nowTop[1]); ctx.lineTo(nowBot[0], nowBot[1]); ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2; ctx.stroke();
    }
    dust(true);
    // Letras: la que sale arriba, la que entra abajo. Aparecen y se van con un fundido corto; al final la nueva
    // se funde abajo y reaparece arriba, sin cruzar su onda
    // Cabecera pequeña (portada, título, artista) y debajo la letra al estilo Spicy Lyrics, alineada a la izquierda
    const lyric = (song, y, alpha, size, below) => {
      if (!song || alpha <= 0.01) return;
      const accent = song.pal.c[1] ?? song.pal.c[0];
      ctx.save(); ctx.globalAlpha = alpha;
      if (song.img) { ctx.save(); rr(ctx, 90, y, 84, 84, 12); ctx.clip(); ctx.drawImage(song.img, 90, y, 84, 84); ctx.restore(); }
      ctx.textAlign = "left"; ctx.fillStyle = "#fff"; fitText(ctx, song.title.toUpperCase(), 780, 46, "", "Anton"); ctx.fillText(song.title.toUpperCase(), 194, y + 44);
      ctx.fillStyle = rgba(accent); ctx.font = "700 26px Inter"; ctx.fillText(`${song.artist.toUpperCase()}${song.bpm ? ` · ${song.bpm} BPM` : ""}`, 194, y + 80);
      ctx.restore();
      spicyLyrics(ctx, song, 90, y + 118, 900, size, below, alpha);
    };
    // Sombra suave detrás de cada bloque de letra: las barras cercanas se apagan al llegar al texto
    const shade = (y0, y1, a) => { if (a <= 0.01) return; const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, `rgba(0,0,0,${(0.55 * a).toFixed(3)})`); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0)); };
    shade(0, 640, 1);
    if (B) shade(CLIP_H, 1380, growB * (1 - smoothStep((m - 0.85) / 0.15)));
    const fadeA = 1 - smoothStep((m - 0.8) / 0.12), fadeB = smoothStep((m - 0.04) / 0.14);
    const leaveB = smoothStep((m - 0.8) / 0.08), topB = smoothStep((m - 0.9) / 0.1);
    lyric(A, 150 - (1 - fadeA) * 30, B ? fadeA : 1, Math.round(lerp(66, 56, into)), hold > 0.5 ? 1 : 2);
    if (B) {
      lyric(B, 1490 + (1 - fadeB) * 30 + leaveB * 30, fadeB * (1 - leaveB), 56, 1);
      lyric(B, 150 + (1 - topB) * 30, topB, 66, 2);
    }
    // Viñeta, cabecera de mezcla y firma
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.78);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.55)"); ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    const hud = B ? smoothStep(m / 0.1) * (1 - smoothStep((m - 0.9) / 0.1)) : 0;
    if (hud > 0) {
      ctx.save(); ctx.globalAlpha = hud; ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = "800 26px Inter"; ctx.fillText("MIXING", W / 2, 70);
      ctx.fillStyle = "rgba(255,255,255,.2)"; ctx.fillRect(340, 92, 400, 4);
      const g = ctx.createLinearGradient(340, 0, 740, 0); g.addColorStop(0, rgba(A.pal.c[0])); g.addColorStop(1, rgba(B.pal.c[0])); ctx.fillStyle = g; ctx.fillRect(340, 92, 400 * m, 4);
      ctx.restore();
    }
    ctx.textAlign = "center"; ctx.font = "800 24px Inter"; ctx.fillStyle = "rgba(255,255,255,.45)"; ctx.fillText("MIX BOOTH", W / 2, H - 60);
  }

  // </clip-art>

  const CLIP_STYLES = {
    orbit: { name: "Orbit", hint: "A 3D camera that holds both songs on the mix", draw: drawOrbit },
    wave: { name: "Waveform", hint: "Each song's waveform in 3D; they overlap on the mix", draw: drawWaveform },
    aura: { name: "Aura", hint: "Liquid colours, words that float in", draw: drawAura },
    kinetic: { name: "Kinetic", hint: "Giant words, a split screen on the mix", draw: drawKinetic },
  };
  const CLIP_MODES = [["mix", "Next mix"], ["15", "15 s"], ["30", "30 s"], ["60", "60 s"]];

  // ----- El clip, dibujado por OBS -----
  // Capturar la ventana daría un clip borroso: en una pantalla normal el clip mide unos 800 px de alto y OBS
  // lo estiraría a 1920. Por eso OBS abre su propia página (una fuente de navegador) con el mismo código de
  // dibujo, a 1080×1920 y 60 fps, y Spotify le va mandando lo que suena por el WebSocket de OBS
  const SHA256_SOURCE = 'function sha256b64(str){const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];const b=new TextEncoder().encode(str);const l=b.length;const n=((l+9+63)>>6)<<6;const m=new Uint8Array(n);m.set(b);m[l]=0x80;const dv=new DataView(m.buffer);dv.setUint32(n-4,l*8);dv.setUint32(n-8,Math.floor(l/0x20000000));let h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];const w=new Uint32Array(64);const r=(x,y)=>(x>>>y)|(x<<(32-y));for(let o=0;o<n;o+=64){for(let i=0;i<16;i++)w[i]=dv.getUint32(o+i*4);for(let i=16;i<64;i++){const s0=r(w[i-15],7)^r(w[i-15],18)^(w[i-15]>>>3),s1=r(w[i-2],17)^r(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)|0;}let[a,bb,c,d,e,f,g,hh]=h;for(let i=0;i<64;i++){const S1=r(e,6)^r(e,11)^r(e,25),ch=(e&f)^(~e&g),t1=(hh+S1+ch+K[i]+w[i])|0,S0=r(a,2)^r(a,13)^r(a,22),mj=(a&bb)^(a&c)^(bb&c),t2=(S0+mj)|0;hh=g;g=f;f=e;e=(d+t1)|0;d=c;c=bb;bb=a;a=(t1+t2)|0;}h=[h[0]+a|0,h[1]+bb|0,h[2]+c|0,h[3]+d|0,h[4]+e|0,h[5]+f|0,h[6]+g|0,h[7]+hh|0];}let bin="";for(const v of h)for(let k=24;k>=0;k-=8)bin+=String.fromCharCode((v>>>k)&255);return btoa(bin);}';
  // La página que abre OBS: una URL data: con todo dentro (no depende de ningún servidor)
  function clipRendererUrl(password, nonce = 0) {
    const source = mixBooth.toString();
    const open = "// <" + "clip-art>", close = "// </" + "clip-art>";
    const art = source.slice(source.indexOf(open), source.indexOf(close));
    // En la página de OBS crypto.subtle no existe (no es un contexto seguro): el SHA-256 va escrito a mano
    const runtime = `
const CLIP_W = ${CLIP_W}, CLIP_H = ${CLIP_H};
${art}
const lastAtOrBefore = ${lastAtOrBefore.toString()};
${beatPhase.toString()}
${lineAt.toString()}
${SHA256_SOURCE}
const FALLBACK_PALETTE = ${JSON.stringify(FALLBACK_PALETTE)};
const STYLES = { orbit: drawOrbit, wave: drawWaveform, aura: drawAura, kinetic: drawKinetic };
const ctx = document.getElementById("c").getContext("2d");
const songs = new Map();
let tick = null, tickAt = 0;
// Reloj propio y suave: cada aviso de Spotify llega con unos milisegundos de baile, y saltar a cada uno
// hace temblar el beat. Se avanza con el tiempo real y se corrige poco a poco; solo un salto grande (un
// cambio de punto en la canción) se aplica de golpe
const clocks = new Map();
function steady(key, target, rate) {
  const now = performance.now(), c = clocks.get(key);
  if (!c || Math.abs(target - (c.val + (now - c.at) * rate)) > 600) { clocks.set(key, { val: target, at: now }); return target; }
  const predicted = c.val + (now - c.at) * rate;
  c.val = predicted + (target - predicted) * 0.06; c.at = now;
  return c.val;
}
function songAt(s, dt) {
  if (!s) return null;
  const info = songs.get(s.uri) || {};
  const pos = steady(s.uri, s.pos + dt * (s.speed || 1), s.speed || 1);
  return { title: info.title || "", artist: info.artist || "", uri: s.uri, bpm: s.bpm, img: info.img || null, pal: info.pal || FALLBACK_PALETTE,
    pos, length: s.length || 1, line: info.lines ? lineAt(info.lines, pos) : null, hasLyrics: !!(info.lines && info.lines.length),
    beat: beatPulse(beatPhase(info.beats ? { beats: info.beats } : null, pos, s.bpm, s.anchor || 0)),
    segs: info.segs || null, beats: info.beats || null, lines: info.lines || null };
}
function frame(now) {
  requestAnimationFrame(frame);
  if (!tick) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, CLIP_W, CLIP_H); return; }
  const dt = Math.min(Date.now() - tickAt, 400);
  const m = tick.inMix ? clamp01(steady("mix", tick.m * tick.dur + dt, 1) / tick.dur) : tick.m;
  const a = songAt(tick.a, dt), b = songAt(tick.b, dt);
  ctx.save(); (STYLES[tick.style] || drawOrbit)(ctx, { now: now / 1000, m, inMix: tick.inMix, mixing: tick.mixing, dur: tick.dur, a, b, cur: m < 0.5 || !b ? a : b }); ctx.restore();
}
const fonts = document.fonts.ready.then(() => Promise.all(["120px Anton", "800 64px Inter", "500 38px Inter", "700 40px Inter", "600 30px Inter"].map((f) => document.fonts.load(f).catch(() => {}))));
const pw = decodeURIComponent(location.hash.slice(1));
let ws;
function connect() {
  ws = new WebSocket("ws://127.0.0.1:4455", "obswebsocket.json");
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.op === 0) {
      const auth = msg.d.authentication;
      ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 1, authentication: auth ? sha256b64(sha256b64(pw + auth.salt) + auth.challenge) : undefined } }));
    } else if (msg.op === 2) {
      await fonts;
      ws.send(JSON.stringify({ op: 6, d: { requestType: "BroadcastCustomEvent", requestId: "ready", requestData: { eventData: { mbClip: "ready" } } } }));
    } else if (msg.op === 5 && msg.d.eventType === "CustomEvent") {
      const d = msg.d.eventData;
      if (d.mbClip === "tick") { tick = d; tickAt = Date.now(); }
      else if (d.mbClip === "song") {
        const old = songs.get(d.uri);
        if (old && old.cover === d.cover) d.img = old.img;
        else if (d.cover) { const img = new Image(); img.crossOrigin = "anonymous"; img.src = d.cover; img.decode().then(() => { const s = songs.get(d.uri); if (s) s.img = img; }, () => {}); }
        songs.set(d.uri, d);
      }
    }
  };
}
connect();
requestAnimationFrame(frame);`;
    const html = `<!doctype html><!-- ${nonce} --><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@500;600;700;800&display=swap"><style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style><canvas id="c" width="${CLIP_W}" height="${CLIP_H}"></canvas><script>${runtime}<\/script>`;
    const bytes = new TextEncoder().encode(html);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:text/html;base64,${btoa(bin)}#${encodeURIComponent(password ?? "")}`;
  }
  // Lo que la página de OBS necesita de cada canción (se manda al cambiar algo y cada pocos segundos por si OBS recargó)
  function clipSongPacket(track) {
    if (!track?.uri) return null;
    const cover = track.big ?? track.cover;
    return { mbClip: "song", uri: track.uri, title: track.name ?? "", artist: track.artist ?? "", cover,
      pal: paletteOf(track.cover) ?? null, lines: lyricsOf(track.uri) ?? null, beats: analysisOf(track.uri)?.beats ?? null,
      // Volumen de cada tramo, redondeado (para la forma de onda)
      segs: analysisOf(track.uri)?.segments?.map((s) => ({ at: Math.round(s.at), loud: Math.round(s.loud * 10) / 10 })) ?? null };
  }
  function clipTickPacket(style) {
    const F = clipFrame(performance.now());
    const ov = F.state.plan?.overlap;
    const part = (song, speed, bpm, anchor) => song && { uri: song.uri, pos: song.pos, speed: F.inMix || F.mixing ? speed || 1 : 1, bpm: song.bpm ?? bpm, anchor, length: song.length };
    return { mbClip: "tick", style, m: F.m, inMix: !!F.inMix, mixing: !!F.mixing, dur: ov?.durationMs || 1,
      a: part(F.a, ov?.speedA, ov?.bpmA, ov?.startAMs ?? 0), b: part(F.b, ov?.speedB, ov?.bpmB, ov?.startBMs ?? 0), tracks: [F.state.a, F.state.b] };
  }

  // ----- OBS -----
  // OBS trae de serie un control remoto (WebSocket). La extensión lo usa para preparar una escena
  // vertical propia, empezar y parar la grabación, y dejar OBS como estaba
  const OBS = { url: "ws://127.0.0.1:4455", profile: "Mix Clip", scene: "Mix Clip", page: "Mix Clip · Clip", video: "Mix Clip · Spotify window", audio: "Mix Clip · Spotify audio", window: "Spotify:Chrome_WidgetWin_1:Spotify.exe" };
  const sha256b64 = async (text) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))));
  function connectObs(password) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(OBS.url, "obswebsocket.json"); } catch (e) { reject(new Error("OBS isn't reachable")); return; }
      const pending = new Map(); let id = 0;
      const timer = setTimeout(() => { reject(new Error("OBS isn't open, or its WebSocket server is off")); try { ws.close(); } catch {} }, 4000);
      const client = {
        request(requestType, requestData = {}) {
          return new Promise((ok, no) => { const requestId = String(++id); pending.set(requestId, { ok, no }); ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } })); });
        },
        close() { try { ws.close(); } catch {} },
        onEvent: null,
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("OBS isn't open, or its WebSocket server is off")); };
      ws.onclose = (event) => { clearTimeout(timer); if (event.code === 4009) reject(new Error("Wrong OBS password")); for (const p of pending.values()) p.no(new Error("OBS closed the connection")); };
      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        if (msg.op === 0) {
          const auth = msg.d.authentication;
          // Eventos generales: por ahí avisa la página del clip de que está lista
          const identify = { rpcVersion: 1, eventSubscriptions: 1 };
          if (auth) identify.authentication = await sha256b64((await sha256b64((password ?? "") + auth.salt)) + auth.challenge);
          ws.send(JSON.stringify({ op: 1, d: identify }));
        } else if (msg.op === 2) { clearTimeout(timer); resolve(client); }
        else if (msg.op === 5) client.onEvent?.(msg.d.eventType, msg.d.eventData);
        else if (msg.op === 7) {
          const p = pending.get(msg.d.requestId); if (!p) return; pending.delete(msg.d.requestId);
          msg.d.requestStatus?.result ? p.ok(msg.d.responseData ?? {}) : p.no(new Error(msg.d.requestStatus?.comment || msg.d.requestType + " failed"));
        }
      };
    });
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // Perfil y escena propios: el canvas vertical no toca tu perfil ni tus escenas de siempre
  // OBS cambia de perfil a su ritmo (y al crear uno ya se cambia a él): se pide una vez y se espera a que lo confirme
  async function switchProfile(obs, profileName) {
    for (let i = 0; i < 25; i++) {
      if ((await obs.request("GetProfileList")).currentProfileName === profileName) { await pause(300); return; }
      if (i === 0 || i === 12) { try { await obs.request("SetCurrentProfile", { profileName }); } catch {} }
      await pause(200);
    }
    throw new Error("OBS didn't switch profile");
  }
  // Lo que se cambia se va anotando en `undo`, para poder deshacerlo aunque la preparación falle a medias
  async function prepareObs(obs, rect, undo, password) {
    const profiles = await obs.request("GetProfileList");
    undo.profile = profiles.currentProfileName;
    if (!profiles.profiles.includes(OBS.profile)) await obs.request("CreateProfile", { profileName: OBS.profile });
    await switchProfile(obs, OBS.profile);
    await obs.request("SetVideoSettings", { baseWidth: CLIP_W, baseHeight: CLIP_H, outputWidth: CLIP_W, outputHeight: CLIP_H, fpsNumerator: 60, fpsDenominator: 1 });
    // Calidad alta (la que OBS llama "indistinguible"): TikTok o Instagram recomprimen, y cuanto mejor llega
    // el original, mejor se ve después. Unos 2 MB por segundo, con el audio a 192 kbps
    for (const [parameterCategory, parameterName, parameterValue] of [["Output", "Mode", "Simple"], ["SimpleOutput", "RecFormat2", "mp4"], ["SimpleOutput", "RecQuality", "HQ"]]) {
      try { await obs.request("SetProfileParameter", { parameterCategory, parameterName, parameterValue }); } catch {}
    }
    const scenes = await obs.request("GetSceneList");
    undo.scene = scenes.currentProgramSceneName;
    if (!scenes.scenes.some((s) => s.sceneName === OBS.scene)) await obs.request("CreateScene", { sceneName: OBS.scene });
    const inputs = (await obs.request("GetInputList")).inputs;
    if (!inputs.some((i) => i.inputName === OBS.audio)) await obs.request("CreateInput", { sceneName: OBS.scene, inputName: OBS.audio, inputKind: "wasapi_process_output_capture", inputSettings: { window: OBS.window, priority: 2 } });
    await obs.request("SetCurrentProgramScene", { sceneName: OBS.scene });
    // El clip lo dibuja OBS en una página propia; si no puede (OBS sin fuente de navegador), se captura la ventana
    const ready = new Promise((ok) => {
      obs.onEvent = (type, data) => { if (type === "CustomEvent" && data?.mbClip === "ready") ok(true); };
      setTimeout(() => ok(false), 10000);
    });
    // La marca de tiempo hace que la URL cambie siempre, y así OBS recarga la página
    const pageSettings = { url: clipRendererUrl(password, Date.now()), width: CLIP_W, height: CLIP_H, fps_custom: true, fps: 60, reroute_audio: false, shutdown: true, restart_when_active: false };
    let pageOk = false;
    try {
      if (inputs.some((i) => i.inputName === OBS.page)) await obs.request("SetInputSettings", { inputName: OBS.page, inputSettings: pageSettings });
      else await obs.request("CreateInput", { sceneName: OBS.scene, inputName: OBS.page, inputKind: "browser_source", inputSettings: pageSettings });
      pageOk = await ready;
    } catch {}
    undo.windowMode = !pageOk;
    await showOnly(obs, pageOk ? OBS.page : OBS.video, inputs);
    // Solo suena Spotify: el audio general del escritorio y el micrófono se silencian mientras se graba
    undo.muted = [];
    for (const input of inputs.filter((i) => /wasapi_(output|input)_capture/.test(i.inputKind))) {
      try { const { inputMuted } = await obs.request("GetInputMute", { inputName: input.inputName }); if (!inputMuted) { await obs.request("SetInputMute", { inputName: input.inputName, inputMuted: true }); undo.muted.push(input.inputName); } } catch {}
    }
    if (undo.windowMode) await fitCapture(obs, rect);
  }
  // Deja visible en la escena solo la fuente que toca (la página del clip o la captura de la ventana)
  async function showOnly(obs, name, inputs) {
    if (name === OBS.video && !inputs.some((i) => i.inputName === OBS.video)) {
      await obs.request("CreateInput", { sceneName: OBS.scene, inputName: OBS.video, inputKind: "window_capture", inputSettings: { window: OBS.window, priority: 2, method: 2, cursor: false, client_area: true } });
    }
    for (const sourceName of [OBS.page, OBS.video]) {
      try {
        const { sceneItemId } = await obs.request("GetSceneItemId", { sceneName: OBS.scene, sourceName });
        await obs.request("SetSceneItemEnabled", { sceneName: OBS.scene, sceneItemId, sceneItemEnabled: sourceName === name });
      } catch {}
    }
  }
  // Recorta la captura de la ventana justo al rectángulo del clip y la estira a 1080×1920
  async function fitCapture(obs, rect) {
    const { sceneItemId } = await obs.request("GetSceneItemId", { sceneName: OBS.scene, sourceName: OBS.video });
    let tr = null;
    for (let i = 0; i < 20; i++) { tr = (await obs.request("GetSceneItemTransform", { sceneName: OBS.scene, sceneItemId })).sceneItemTransform; if (tr.sourceWidth > 0) break; await pause(150); }
    const k = devicePixelRatio;
    const left = Math.round(rect.left * k), top = Math.round(rect.top * k), w = Math.round(rect.width * k), h = Math.round(rect.height * k);
    await obs.request("SetSceneItemTransform", { sceneName: OBS.scene, sceneItemId, sceneItemTransform: {
      cropLeft: left, cropTop: top, cropRight: Math.max(0, Math.round(tr.sourceWidth - left - w)), cropBottom: Math.max(0, Math.round(tr.sourceHeight - top - h)),
      positionX: 0, positionY: 0, alignment: 5, boundsType: "OBS_BOUNDS_STRETCH", boundsWidth: CLIP_W, boundsHeight: CLIP_H, boundsAlignment: 0,
    } });
  }
  async function restoreObs(obs, undo) {
    if (!undo) return;
    for (const inputName of undo.muted ?? []) { try { await obs.request("SetInputMute", { inputName, inputMuted: false }); } catch {} }
    try { if (undo.scene) await obs.request("SetCurrentProgramScene", { sceneName: undo.scene }); } catch {}
    try { if (undo.profile && undo.profile !== OBS.profile) await switchProfile(obs, undo.profile); } catch {}
  }

  // ----- Panel de clip y grabación -----
  let clip = null;

  function openClipSetup() {
    if (!booth || clip) return;
    loadClipFonts();
    const panel = el("div", "mb-clip-setup", booth.root);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Record a clip");
    el("h2", "", panel).textContent = "Record a clip";
    const sub = el("p", "mb-note", panel);
    sub.textContent = "A vertical video (1080×1920) of the song or the mix, recorded by OBS with Spotify's sound.";
    const styles = el("div", "mb-clip-styles", panel);
    styles.setAttribute("role", "radiogroup");
    styles.setAttribute("aria-label", "Style");
    let chosen = store.get(CLIP_STYLE_KEY, "orbit");
    if (!CLIP_STYLES[chosen]) chosen = "orbit";
    const previews = [];
    for (const [key, info] of Object.entries(CLIP_STYLES)) {
      const card = el("button", "mb-clip-style", styles);
      card.type = "button";
      card.setAttribute("role", "radio");
      const canvas = el("canvas", "", card);
      canvas.width = CLIP_W / 4; canvas.height = CLIP_H / 4;
      el("b", "", card).textContent = info.name;
      el("span", "", card).textContent = info.hint;
      card.addEventListener("click", () => { chosen = key; store.set(CLIP_STYLE_KEY, key); refresh(); });
      previews.push({ key, card, ctx: canvas.getContext("2d") });
    }
    const modes = el("div", "mb-row", panel);
    el("label", "", modes).textContent = "Record";
    let mode = store.get(CLIP_MODE_KEY, "mix");
    const modeButtons = CLIP_MODES.map(([key, label]) => {
      const b = el("button", "mb-btn", modes); b.type = "button"; b.textContent = label;
      b.addEventListener("click", () => { mode = key; store.set(CLIP_MODE_KEY, key); refresh(); });
      return { key, b };
    });
    const pass = el("div", "mb-row", panel);
    el("label", "", pass).textContent = "OBS password";
    const input = el("input", "mb-input", pass);
    input.type = "password"; input.autocomplete = "off"; input.value = store.get(OBS_PASSWORD_KEY, "");
    input.placeholder = "Tools → WebSocket Server Settings";
    input.setAttribute("aria-label", "OBS WebSocket password");
    const actions = el("div", "mb-row", panel);
    const go = el("button", "mb-btn is-primary", actions); go.innerHTML = '<i class="mb-dot" aria-hidden="true"></i>Record';
    const back = el("button", "mb-btn", actions); back.textContent = "Back";
    const note = el("p", "mb-note", panel);
    note.textContent = "Open OBS first (it can stay minimised). Your OBS profile and scenes are left as they were.";
    const refresh = () => {
      previews.forEach((p) => { p.card.classList.toggle("is-on", p.key === chosen); p.card.setAttribute("aria-checked", String(p.key === chosen)); });
      modeButtons.forEach(({ key, b }) => { b.classList.toggle("is-on", key === mode); b.setAttribute("aria-pressed", String(key === mode)); });
    };
    refresh();
    // Vistas previas en vivo, a 20 cuadros por segundo para no cargar la cabina
    let alive = true, lastDraw = 0;
    const loop = (now) => {
      if (!alive) return;
      requestAnimationFrame(loop);
      if (now - lastDraw < 50) return;
      lastDraw = now;
      const F = clipFrame(now);
      for (const p of previews) { p.ctx.save(); p.ctx.scale(0.25, 0.25); CLIP_STYLES[p.key].draw(p.ctx, F); p.ctx.restore(); }
    };
    requestAnimationFrame(loop);
    const close = () => { alive = false; panel.remove(); booth && (booth.clipSetup = null); };
    booth.clipSetup = { close };
    back.addEventListener("click", close);
    go.addEventListener("click", () => {
      store.set(OBS_PASSWORD_KEY, input.value);
      close();
      startClip({ style: chosen, mode, password: input.value });
    });
    previews[0].card.focus();
  }

  async function startClip({ style, mode, password }) {
    const root = el("div", "mb-clip", document.body);
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Clip recording");
    const side = el("div", "mb-clip-side", root);
    el("h2", "", side).textContent = CLIP_STYLES[style].name;
    const status = el("p", "mb-clip-status", side);
    const counter = el("div", "mb-clip-counter", side);
    const stopBtn = el("button", "mb-btn is-primary", side); stopBtn.textContent = "Stop";
    const cancelBtn = el("button", "mb-btn", side); cancelBtn.textContent = "Cancel";
    const canvas = el("canvas", "mb-clip-canvas", root);
    canvas.width = CLIP_W; canvas.height = CLIP_H;
    const ctx = canvas.getContext("2d");
    clip = { root, alive: true, recording: false };
    let raf = 0;
    const draw = (now) => { if (!clip?.alive) return; raf = requestAnimationFrame(draw); ctx.save(); CLIP_STYLES[style].draw(ctx, clipFrame(now)); ctx.restore(); };
    raf = requestAnimationFrame(draw);

    let obs = null, stopRequested = false;
    const undo = {};
    const finish = async (save) => {
      if (!clip?.alive) return;
      clip.alive = false;
      clearInterval(clip.feed);
      cancelAnimationFrame(raf);
      let path = null;
      if (obs) {
        try {
          if (clip.recording) {
            path = (await obs.request("StopRecord")).outputPath;
            // Se espera a que OBS cierre el archivo antes de cambiarle el perfil
            for (let i = 0; i < 40; i++) { if (!(await obs.request("GetRecordStatus")).outputActive) break; await pause(150); }
          }
        } catch {}
        await restoreObs(obs, undo);
        obs.close();
      }
      root.remove();
      clip = null;
      if (path && save) Spicetify.showNotification?.(`Clip saved: ${path}`);
      else if (path) Spicetify.showNotification?.(`Recording stopped: ${path}`);
    };
    stopBtn.addEventListener("click", () => { stopRequested = true; if (!clip?.recording) finish(false); });
    cancelBtn.addEventListener("click", () => finish(false));
    root.addEventListener("keydown", (e) => { if (e.key === "Escape") finish(false); });
    stopBtn.focus();

    try {
      status.textContent = "Connecting to OBS…";
      obs = await connectObs(password);
      // A la página que dibuja el clip en OBS se le manda lo que suena 20 veces por segundo; ella anima entre medias.
      // Lo de cada canción (letra, colores, beats) solo cuando cambia, y cada 3 s por si la página recargó
      const sentSongs = new Map();
      let lastFull = 0;
      const feed = () => {
        if (!clip?.alive || !obs) return;
        const tick = clipTickPacket(style);
        const tracks = tick.tracks; delete tick.tracks;
        const now = performance.now(), full = now - lastFull > 3000;
        if (full) lastFull = now;
        for (const track of tracks) {
          const packet = clipSongPacket(track);
          if (!packet) continue;
          const sig = `${packet.cover}|${!!packet.pal}|${packet.lines?.length ?? -1}|${packet.beats?.length ?? -1}|${packet.segs?.length ?? -1}`;
          if (!full && sentSongs.get(packet.uri) === sig) continue;
          sentSongs.set(packet.uri, sig);
          obs.request("BroadcastCustomEvent", { eventData: packet }).catch(() => {});
        }
        obs.request("BroadcastCustomEvent", { eventData: tick }).catch(() => {});
      };
      clip.feed = setInterval(feed, 50);
      status.textContent = "Preparing the vertical scene…";
      await pause(300);
      await prepareObs(obs, canvas.getBoundingClientRect(), undo, password);
    } catch (error) {
      // Lo que se llegó a cambiar en OBS se deshace antes de avisar
      if (obs) { await restoreObs(obs, undo); obs.close(); obs = null; }
      status.textContent = `${error.message}. The clip is still on screen, so you can record it yourself.`;
      return;
    }

    // Cuándo empezar y cuándo parar
    const PREROLL_MS = 6000, TAIL_MS = 2500;
    let endAt = null;
    if (mode === "mix") {
      for (;;) {
        if (!clip?.alive) return;
        const s = readState();
        if (s.mixing) break;
        // La cuenta atrás de 3 s termina justo cuando faltan 6 s para la mezcla
        if (s.plan?.overlap && s.elapsed !== null && s.elapsed >= -PREROLL_MS - 3200) break;
        status.textContent = s.plan?.overlap ? "Waiting for the mix…" : "No mix to the next song yet. Waiting…";
        counter.textContent = s.plan?.overlap ? time(-s.elapsed - PREROLL_MS - 3200) : "";
        await pause(200);
      }
    }
    // Sin sonido en Spotify, OBS grabaría un clip mudo: se espera a que suene
    while (clip?.alive && (Spicetify.Player.getMute?.() || Spicetify.Player.getVolume() === 0)) {
      status.textContent = "Spotify is muted. Turn the volume up and the recording will start.";
      counter.textContent = "🔇";
      await pause(300);
    }
    // Cuenta atrás fuera del vídeo; la grabación empieza al terminar
    for (let n = 3; n >= 1; n--) { if (!clip?.alive) return; counter.textContent = String(n); status.textContent = "Recording in"; await pause(1000); }
    try {
      // La ventana pudo moverse: se vuelve a encajar justo antes de grabar
      if (undo.windowMode) await fitCapture(obs, canvas.getBoundingClientRect());
      // OBS contesta "ok" enseguida pero tarda en grabar de verdad (y justo tras cambiar de perfil a veces no arranca):
      // se comprueba que esté grabando y, si no, se le vuelve a pedir
      let active = false;
      for (let attempt = 0; attempt < 2 && !active; attempt++) {
        try { await obs.request("StartRecord"); } catch {}
        for (let i = 0; i < 30 && !active; i++) { await pause(150); active = (await obs.request("GetRecordStatus")).outputActive; }
      }
      if (!active) throw new Error("OBS didn't start recording");
      clip.recording = true;
    } catch (error) {
      status.textContent = `OBS couldn't start recording: ${error.message}`;
      return;
    }
    const startedAt = performance.now();
    let sawMix = false;
    while (clip?.alive) {
      const elapsed = performance.now() - startedAt;
      counter.textContent = "● " + time(elapsed);
      if (mode === "mix") {
        const s = readState();
        const inMix = s.mixing || (s.plan?.overlap && s.elapsed !== null && s.elapsed >= 0);
        if (inMix) sawMix = true;
        status.textContent = inMix ? "Recording the mix" : sawMix ? "Mix done, finishing…" : "Recording, the mix is coming";
        // El final se fija al salir de la mezcla y se anula si vuelve a estar dentro (una lectura suelta no corta)
        if (inMix) endAt = null;
        else if (sawMix && endAt === null) endAt = elapsed + TAIL_MS;
        if (elapsed > 180000) endAt = elapsed;
      } else {
        status.textContent = "Recording";
        endAt = Number(mode) * 1000;
      }
      if (stopRequested || (endAt !== null && elapsed >= endAt)) break;
      await pause(200);
    }
    await finish(true);
  }

  // ---------- Entradas ----------

  // Con ancho y alto: sin ellos Spotify deja el icono a tamaño cero y el botón se ve vacío
  // Un disco con el brazo encima
  // Mismo cuadro y grosor que los iconos de Spotify: llena los 16 px con trazo de 1,5
  // El disco ocupa todo el cuadro y el brazo se apoya encima, como en un tocadiscos
  const ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="7.25"/><circle cx="8" cy="8" r="2.25"/><circle cx="8" cy="8" r="0.75" fill="currentColor" stroke="none"/><path d="M13.6 2.4 10.4 9.6" stroke-linecap="round" stroke-width="1.6"/><circle cx="13.6" cy="2.4" r="1.25" fill="currentColor" stroke="none"/></svg>`;
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
