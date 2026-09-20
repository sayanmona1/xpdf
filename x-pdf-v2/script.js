/* ==========================================================
   X PDF — Image to PDF converter
   Everything runs locally in the browser. Nothing is uploaded.
   ========================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------
   * Constants
   * ---------------------------------------------------------- */
  const PX_TO_PT = 0.75; // 96 CSS px = 72 PDF points
  const PAGE_SIZES = {   // portrait sizes in PDF points
    a4: [595.28, 841.89],
    letter: [612, 792],
    a5: [419.53, 595.28],
  };
  const QUALITY_LEVELS = {
    1: { label: 'Low', maxSide: 1400, jpeg: 0.55 },
    2: { label: 'Medium', maxSide: 2200, jpeg: 0.75 },
    3: { label: 'High', maxSide: Infinity, jpeg: 0.95 },
  };
  const MAX_CANVAS_SIDE = 8192;          // keep canvases within browser limits
  const MAX_CANVAS_PIXELS = 16_000_000;  // iOS Safari allows ~16.7M pixels
  const PREVIEW_WIDTH = 320;             // px, preview canvas resolution
  const DEFAULT_FILENAME = 'images-to-pdf';

  /* ------------------------------------------------------------
   * State
   * ---------------------------------------------------------- */
  const state = {
    images: [],   // { id, file, name, type, url, el, width, height, rotation, exif }
    settings: { pageSize: 'a4', orientation: 'auto', fit: 'fit', margin: 20, quality: 3 },
    busy: false,
    view: 'empty',
    result: null, // { blob, name, count, size }
  };
  let nextId = 1;
  let previewToken = 0;
  let previewTimer = null;

  class UserError extends Error {}

  /* ------------------------------------------------------------
   * DOM references
   * ---------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    views: { empty: $('emptyView'), editor: $('editorView'), success: $('successView') },
    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    chooseBtn: $('chooseBtn'),
    addMoreBtn: $('addMoreBtn'),
    imageList: $('imageList'),
    imageCount: $('imageCount'),
    previewGrid: $('previewGrid'),
    previewMeta: $('previewMeta'),
    colMain: $('colMain'),
    settingsPanel: $('settingsPanel'),
    pageSize: $('pageSize'),
    orientationField: $('orientationField'),
    fitField: $('fitField'),
    originalNote: $('originalNote'),
    margin: $('margin'),
    marginOut: $('marginOut'),
    quality: $('quality'),
    qualityOut: $('qualityOut'),
    filename: $('filename'),
    progress: $('progress'),
    progressText: $('progressText'),
    progressFill: $('progressFill'),
    downloadBtn: $('downloadBtn'),
    downloadLabel: $('downloadLabel'),
    successTitle: $('successTitle'),
    successText: $('successText'),
    successFile: $('successFile'),
    downloadAgainBtn: $('downloadAgainBtn'),
    resetBtn: $('resetBtn'),
    alerts: $('alerts'),
    live: $('liveRegion'),
  };

  /* ------------------------------------------------------------
   * Small helpers
   * ---------------------------------------------------------- */
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const icon = (name) => `<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function announce(message) {
    els.live.textContent = '';
    setTimeout(() => { els.live.textContent = message; }, 30);
  }

  /** Returns 'jpeg' | 'png' | 'webp' or null when the file is not supported. */
  function detectType(file) {
    const mime = (file.type || '').toLowerCase();
    if (mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/pjpeg') return 'jpeg';
    if (mime === 'image/png') return 'png';
    if (mime === 'image/webp') return 'webp';
    if (!mime) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
      if (ext === 'png') return 'png';
      if (ext === 'webp') return 'webp';
    }
    return null;
  }

  /** Strip characters that are invalid in filenames. */
  function sanitizeFilename(value) {
    return value
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\.pdf$/i, '')
      .replace(/^\s+/, '');
  }
  function currentFilename() {
    const cleaned = sanitizeFilename(els.filename.value).replace(/[\s.]+$/, '');
    return cleaned || DEFAULT_FILENAME;
  }

  /* ------------------------------------------------------------
   * Alerts
   * ---------------------------------------------------------- */
  function showError(message) {
    const el = document.createElement('div');
    el.className = 'alert';
    el.setAttribute('role', 'alert');
    el.innerHTML = `${icon('alert')}<p></p><button type="button" class="icon-btn" aria-label="Dismiss message">${icon('close')}</button>`;
    el.querySelector('p').textContent = message;
    const dismiss = () => el.remove();
    el.querySelector('button').addEventListener('click', dismiss);
    while (els.alerts.children.length >= 3) els.alerts.firstElementChild.remove();
    els.alerts.appendChild(el);
    setTimeout(dismiss, 9000);
  }
  function clearErrors() { els.alerts.replaceChildren(); }

  function friendlyMessage(err) {
    if (err instanceof UserError) return err.message;
    const text = String((err && err.message) || '');
    if ((err && err.name === 'RangeError') || /memory|allocat|too large/i.test(text)) {
      return 'Your device ran out of memory. Try fewer images or set Image quality to Medium or Low.';
    }
    return 'Something went wrong while creating the PDF. Please try again.';
  }

  /* ------------------------------------------------------------
   * View switching
   * ---------------------------------------------------------- */
  function setView(name) {
    state.view = name;
    for (const [key, el] of Object.entries(els.views)) {
      if (key === name) {
        if (el.hidden) {
          el.hidden = false;
          el.classList.remove('view-enter');
          void el.offsetWidth; // restart the entrance animation
          el.classList.add('view-enter');
        }
      } else {
        el.hidden = true;
      }
    }
  }

  /* ------------------------------------------------------------
   * Loading images
   * ---------------------------------------------------------- */

  /** Reads the EXIF orientation tag (1–8) from the start of a JPEG file. */
  async function readJpegOrientation(file) {
    try {
      const view = new DataView(await file.slice(0, 131072).arrayBuffer());
      if (view.getUint16(0) !== 0xffd8) return 1;
      let offset = 2;
      while (offset + 4 < view.byteLength) {
        const marker = view.getUint16(offset);
        offset += 2;
        if (marker === 0xffda) break;               // start of scan: no more metadata
        if (marker === 0xffe1) {                    // APP1
          if (view.getUint32(offset + 2) !== 0x45786966) return 1; // "Exif"
          const tiff = offset + 8;
          const little = view.getUint16(tiff) === 0x4949;
          const ifd = tiff + view.getUint32(tiff + 4, little);
          const entries = view.getUint16(ifd, little);
          for (let i = 0; i < entries; i++) {
            const entry = ifd + 2 + i * 12;
            if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
          }
          return 1;
        }
        if ((marker & 0xff00) !== 0xff00) break;
        offset += view.getUint16(offset);
      }
    } catch (_) { /* ignore: treat as no orientation */ }
    return 1;
  }

  async function loadImageEntry(file, type) {
    const url = URL.createObjectURL(file);
    const el = new Image();
    try {
      await new Promise((resolve, reject) => {
        el.onload = resolve;
        el.onerror = () => reject(new Error('decode failed'));
        el.src = url;
      });
      if (!el.naturalWidth || !el.naturalHeight) throw new Error('empty image');
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    return {
      id: nextId++,
      file,
      name: file.name,
      type,
      url,
      el,
      width: el.naturalWidth,   // browsers already apply EXIF orientation here
      height: el.naturalHeight,
      rotation: 0,
      exif: type === 'jpeg' ? await readJpegOrientation(file) : 1,
    };
  }

  /** Entry point for the file input, drag & drop, and "Add Images". */
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || state.busy) return;

    const supported = [];
    let unsupported = 0;
    for (const file of files) {
      const type = detectType(file);
      if (type) supported.push({ file, type }); else unsupported++;
    }

    const loaded = [];
    const failed = [];
    const BATCH = 6;
    for (let i = 0; i < supported.length; i += BATCH) {
      const batch = supported.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map((s) => loadImageEntry(s.file, s.type)));
      results.forEach((res, idx) => {
        if (res.status === 'fulfilled') loaded.push(res.value); else failed.push(batch[idx].file.name);
      });
    }

    if (unsupported) {
      showError(`${plural(unsupported, 'file')} ${unsupported === 1 ? 'was' : 'were'} skipped. X PDF supports JPG, PNG and WEBP images.`);
    }
    if (failed.length === 1) {
      showError(`“${failed[0]}” couldn’t be read and was skipped. The file may be corrupted.`);
    } else if (failed.length > 1) {
      showError(`${failed.length} images couldn’t be read and were skipped. The files may be corrupted.`);
    }
    if (loaded.length) addImages(loaded);
  }

  function addImages(entries) {
    state.images.push(...entries);
    if (state.view !== 'editor') {
      setView('editor');
      syncSettings();
    }
    renderImageList();
    renderPreview();
    announce(`${plural(entries.length, 'image')} added. ${plural(state.images.length, 'image')} in total.`);
  }

  /* ------------------------------------------------------------
   * Image list (editor)
   * ---------------------------------------------------------- */
  function renderImageList() {
    const list = els.imageList;
    list.replaceChildren();
    const total = state.images.length;
    els.imageCount.textContent = plural(total, 'image');

    state.images.forEach((img, index) => {
      const li = document.createElement('li');
      li.className = 'image-card';
      li.dataset.id = String(img.id);
      li.innerHTML = `
        <button type="button" class="card-handle" aria-label="Reorder image. Drag, or use the up and down arrow keys.">${icon('grip')}</button>
        <div class="thumb"><img alt=""><span class="num"></span></div>
        <div class="card-info">
          <div class="card-name"></div>
          <div class="card-meta"></div>
        </div>
        <div class="card-actions">
          <button type="button" class="icon-btn" data-action="up">${icon('up')}</button>
          <button type="button" class="icon-btn" data-action="down">${icon('down')}</button>
          <button type="button" class="icon-btn" data-action="rotate">${icon('rotate')}</button>
          <button type="button" class="icon-btn danger" data-action="remove">${icon('trash')}</button>
        </div>`;

      const thumb = li.querySelector('.thumb img');
      thumb.src = img.url;
      thumb.style.transform = `rotate(${img.rotation}deg)`;
      li.querySelector('.num').textContent = String(index + 1);
      li.querySelector('.card-name').textContent = img.name;
      li.querySelector('.card-name').title = img.name;
      li.querySelector('.card-meta').textContent = `${img.width} × ${img.height} · ${formatBytes(img.file.size)}`;

      const label = (action, text) => li.querySelector(`[data-action="${action}"]`).setAttribute('aria-label', `${text} ${img.name}`);
      label('up', 'Move up');
      label('down', 'Move down');
      label('rotate', 'Rotate 90° clockwise');
      label('remove', 'Remove');
      li.querySelector('[data-action="up"]').disabled = index === 0;
      li.querySelector('[data-action="down"]').disabled = index === total - 1;
      list.appendChild(li);
    });
  }

  function findEntry(id) { return state.images.find((i) => i.id === id); }

  function removeImage(id) {
    const index = state.images.findIndex((i) => i.id === id);
    if (index === -1) return;
    const [entry] = state.images.splice(index, 1);
    const card = els.imageList.querySelector(`[data-id="${id}"]`);
    els.imageCount.textContent = plural(state.images.length, 'image');
    announce(`Removed ${entry.name}. ${plural(state.images.length, 'image')} left.`);

    const finish = () => {
      URL.revokeObjectURL(entry.url); // free memory
      if (!state.images.length) {
        setView('empty');
        els.chooseBtn.focus({ preventScroll: true });
        return;
      }
      renderImageList();
      const next = els.imageList.children[Math.min(index, state.images.length - 1)];
      if (next) next.querySelector('[data-action="remove"]').focus({ preventScroll: true });
    };
    renderPreview();
    if (card) {
      card.classList.add('removing');
      setTimeout(finish, 240);
    } else {
      finish();
    }
  }

  /** Moves an image up (-1) or down (+1) in the page order. */
  function moveImage(id, delta, focusSelector) {
    const from = state.images.findIndex((i) => i.id === id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= state.images.length) return;
    const [entry] = state.images.splice(from, 1);
    state.images.splice(to, 0, entry);
    renderImageList();
    renderPreview();
    announce(`${entry.name} moved to position ${to + 1} of ${state.images.length}.`);
    const card = els.imageList.querySelector(`[data-id="${id}"]`);
    if (card) {
      let target = card.querySelector(focusSelector);
      if (target && target.disabled) target = card.querySelector(delta < 0 ? '[data-action="down"]' : '[data-action="up"]');
      if (target) target.focus({ preventScroll: true });
    }
  }

  function rotateImage(id) {
    const entry = findEntry(id);
    if (!entry) return;
    entry.rotation = (entry.rotation + 90) % 360;
    const card = els.imageList.querySelector(`[data-id="${id}"]`);
    if (card) card.querySelector('.thumb img').style.transform = `rotate(${entry.rotation}deg)`;
    renderPreview();
    announce(`${entry.name} rotated to ${entry.rotation} degrees.`);
  }

  /* Pointer-based drag & drop reordering (works with mouse, touch and pen) */
  function startPointerDrag(e, card) {
    if (state.busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const list = els.imageList;
    handle.setPointerCapture(e.pointerId);
    const grabOffset = e.clientY - card.getBoundingClientRect().top;
    const startOrder = Array.from(list.children).map((li) => li.dataset.id).join(',');
    card.classList.add('is-dragging');
    document.body.classList.add('is-reordering');

    const onMove = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (ev.clientY < 70) window.scrollBy(0, -14);
      else if (window.innerHeight - ev.clientY < 70) window.scrollBy(0, 14);

      // Reorder the DOM live, based on where the dragged card's centre is.
      const center = ev.clientY - grabOffset + card.offsetHeight / 2;
      const siblings = Array.from(list.children).filter((c) => c !== card);
      const before = siblings.find((c) => {
        const r = c.getBoundingClientRect();
        return r.top + r.height / 2 > center;
      });
      if (before) { if (card.nextElementSibling !== before) list.insertBefore(card, before); }
      else if (list.lastElementChild !== card) list.appendChild(card);

      card.style.transform = 'none';
      const natural = card.getBoundingClientRect().top;
      card.style.transform = `translateY(${ev.clientY - grabOffset - natural}px)`;
    };

    const onEnd = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      card.classList.remove('is-dragging');
      card.style.transform = '';
      document.body.classList.remove('is-reordering');

      // Commit the new order from the DOM into state.
      const order = Array.from(list.children).map((li) => Number(li.dataset.id));
      if (order.join(',') !== startOrder) {
        state.images = order.map(findEntry);
        renderImageList();
        renderPreview();
        const moved = state.images.findIndex((i) => i.id === Number(card.dataset.id));
        announce(`Image moved to position ${moved + 1} of ${state.images.length}.`);
        const newHandle = list.querySelector(`[data-id="${card.dataset.id}"] .card-handle`);
        if (newHandle && ev.type === 'pointerup') newHandle.focus({ preventScroll: true });
      }
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }

  /* ------------------------------------------------------------
   * Layout — shared by the preview and the PDF so they always match
   * ---------------------------------------------------------- */

  /**
   * Works out the PDF page size and where the image goes on it.
   * All values are in PDF points; box.y is measured from the top.
   * `crop` (fractions of the rotated image) is only set for "Fill Page".
   */
  function computeLayout(entry, s) {
    const sideways = entry.rotation % 180 !== 0;
    const rw = sideways ? entry.height : entry.width;   // image size after rotation
    const rh = sideways ? entry.width : entry.height;
    const margin = s.margin * PX_TO_PT;
    const naturalW = rw * PX_TO_PT;
    const naturalH = rh * PX_TO_PT;

    // "Original Image Size": the page wraps the image (plus margins).
    if (s.pageSize === 'original') {
      return {
        rw, rh, crop: null,
        pageW: naturalW + margin * 2,
        pageH: naturalH + margin * 2,
        box: { x: margin, y: margin, w: naturalW, h: naturalH },
      };
    }

    let [pageW, pageH] = PAGE_SIZES[s.pageSize];
    const landscape = s.orientation === 'landscape' || (s.orientation === 'auto' && rw > rh);
    if (landscape) [pageW, pageH] = [pageH, pageW];

    const availW = pageW - margin * 2;
    const availH = pageH - margin * 2;

    if (s.fit === 'fill') {
      // Cover the whole content area and crop the overflow (centred).
      const imageRatio = rw / rh;
      const areaRatio = availW / availH;
      const crop = imageRatio > areaRatio
        ? { w: areaRatio / imageRatio, h: 1 }
        : { w: 1, h: imageRatio / areaRatio };
      crop.x = (1 - crop.w) / 2;
      crop.y = (1 - crop.h) / 2;
      return { rw, rh, pageW, pageH, crop, box: { x: margin, y: margin, w: availW, h: availH } };
    }

    const fitScale = Math.min(availW / naturalW, availH / naturalH);
    // "Fit to Page" scales up or down; "Original Size" never enlarges the image.
    const scale = s.fit === 'original' ? Math.min(1, fitScale) : fitScale;
    const w = naturalW * scale;
    const h = naturalH * scale;
    return { rw, rh, pageW, pageH, crop: null, box: { x: (pageW - w) / 2, y: (pageH - h) / 2, w, h } };
  }

  /**
   * Draws the (rotated, optionally cropped) image into `dest` on a canvas.
   * Used for both the preview and for the pixels embedded in the PDF.
   */
  function drawEntry(ctx, entry, dest, crop) {
    const c = crop || { x: 0, y: 0, w: 1, h: 1 };
    const sideways = entry.rotation % 180 !== 0;
    const rw = sideways ? entry.height : entry.width;
    const rh = sideways ? entry.width : entry.height;
    const k = dest.w / (c.w * rw);

    ctx.save();
    ctx.beginPath();
    ctx.rect(dest.x, dest.y, dest.w, dest.h);
    ctx.clip();
    ctx.translate(dest.x, dest.y);
    ctx.scale(k, k);
    ctx.translate(-c.x * rw, -c.y * rh);
    if (entry.rotation === 90) { ctx.translate(rw, 0); ctx.rotate(Math.PI / 2); }
    else if (entry.rotation === 180) { ctx.translate(rw, rh); ctx.rotate(Math.PI); }
    else if (entry.rotation === 270) { ctx.translate(0, rh); ctx.rotate(Math.PI * 1.5); }
    ctx.drawImage(entry.el, 0, 0, entry.width, entry.height);
    ctx.restore();
  }

  /* ------------------------------------------------------------
   * Preview
   * ---------------------------------------------------------- */
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 120);
  }

  function renderPreview() {
    clearTimeout(previewTimer);
    const token = ++previewToken;
    const grid = els.previewGrid;
    grid.replaceChildren();
    const total = state.images.length;
    els.previewMeta.textContent = plural(total, 'page');
    if (!total) return;

    const jobs = state.images.map((entry, i) => {
      const layout = computeLayout(entry, state.settings);
      const figure = document.createElement('figure');
      figure.className = 'page-thumb';
      const wrap = document.createElement('div');
      wrap.className = 'sheet-wrap';
      const canvas = document.createElement('canvas');
      canvas.width = PREVIEW_WIDTH;
      canvas.height = Math.max(1, Math.round((PREVIEW_WIDTH * layout.pageH) / layout.pageW));
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Page ${i + 1}: ${entry.name}`);
      wrap.appendChild(canvas);
      const caption = document.createElement('figcaption');
      caption.textContent = `Page ${i + 1}`;
      figure.append(wrap, caption);
      grid.appendChild(figure);
      return { canvas, entry, layout };
    });

    // Draw a few pages per frame so large collections never freeze the UI.
    let next = 0;
    const step = () => {
      if (token !== previewToken) return;
      const end = Math.min(next + 4, jobs.length);
      for (; next < end; next++) {
        const { canvas, entry, layout } = jobs[next];
        const ctx = canvas.getContext('2d');
        const scale = canvas.width / layout.pageW;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = 'high';
        drawEntry(ctx, entry, {
          x: layout.box.x * scale, y: layout.box.y * scale,
          w: layout.box.w * scale, h: layout.box.h * scale,
        }, layout.crop);
      }
      if (next < jobs.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------
   * Settings
   * ---------------------------------------------------------- */
  function readSettings() {
    const s = state.settings;
    s.pageSize = els.pageSize.value;
    s.orientation = document.querySelector('input[name="orientation"]:checked').value;
    s.fit = document.querySelector('input[name="fit"]:checked').value;
    s.margin = Number(els.margin.value);
    s.quality = Number(els.quality.value);
  }

  function setRangeFill(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--p', `${pct}%`);
  }

  /** Updates labels / disabled states so the UI matches the settings. */
  function syncSettings() {
    const s = state.settings;
    els.marginOut.textContent = `${s.margin} px`;
    const q = QUALITY_LEVELS[s.quality].label;
    els.qualityOut.textContent = q;
    els.quality.setAttribute('aria-valuetext', q);
    setRangeFill(els.margin);
    setRangeFill(els.quality);
    const original = s.pageSize === 'original';
    els.orientationField.disabled = original;
    els.fitField.disabled = original;
    els.originalNote.hidden = !original;
  }

  function updateSettings() {
    readSettings();
    syncSettings();
    schedulePreview();
  }

  /* ------------------------------------------------------------
   * PDF generation
   * ---------------------------------------------------------- */
  function setProgress(percent, text) {
    els.progressFill.style.width = `${percent}%`;
    els.progressText.textContent = text;
    els.progress.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', String(Math.round(percent)));
  }

  /** Checks whether an image has any (semi-)transparent pixels. */
  function hasTransparency(entry) {
    if (typeof entry.transparent === 'boolean') return entry.transparent;
    const size = 48;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(entry.el, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let found = false;
    for (let i = 3; i < data.length; i += 4) { if (data[i] < 250) { found = true; break; } }
    entry.transparent = found;
    return found;
  }

  /**
   * Draws the image on a canvas (applying rotation, EXIF orientation, Fill-Page
   * cropping and the quality level) and encodes it as JPEG or PNG bytes.
   */
  async function renderToBytes(entry, layout, s) {
    const q = QUALITY_LEVELS[s.quality];
    const crop = layout.crop || { x: 0, y: 0, w: 1, h: 1 };
    const srcW = crop.w * layout.rw;
    const srcH = crop.h * layout.rh;
    const longest = Math.max(srcW, srcH);
    const scale = Math.min(
      1,
      q.maxSide / longest,
      MAX_CANVAS_SIDE / longest,
      Math.sqrt(MAX_CANVAS_PIXELS / (srcW * srcH)),
    );
    const outW = Math.max(1, Math.round(srcW * scale));
    const outH = Math.max(1, Math.round(srcH * scale));

    // Decide the output format.
    let format;
    if (s.quality < 3 || entry.type === 'jpeg') format = 'jpg';
    else if (entry.type === 'png') format = 'png';
    else format = hasTransparency(entry) ? 'png' : 'jpg'; // WEBP → PNG (alpha) or JPEG

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    if (format === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outW, outH); } // no black behind transparency
    ctx.imageSmoothingQuality = 'high';
    drawEntry(ctx, entry, { x: 0, y: 0, w: outW, h: outH }, crop);

    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, format === 'png' ? 'image/png' : 'image/jpeg', q.jpeg);
    });
    canvas.width = canvas.height = 0; // release the pixel buffer
    if (!blob) throw new Error('Image encoding failed');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), format };
  }

  /** Embeds an image into the document, using the original bytes whenever it is safe to. */
  async function embedImage(pdfDoc, entry, layout, s) {
    // Fast path: untouched JPG/PNG at High quality is embedded as-is (no re-encoding,
    // no duplicated pixel data). Anything else goes through the canvas.
    const canEmbedDirectly =
      s.quality === 3 && entry.rotation === 0 && !layout.crop && entry.exif <= 1 &&
      (entry.type === 'jpeg' || entry.type === 'png');

    if (canEmbedDirectly) {
      try {
        const bytes = new Uint8Array(await entry.file.arrayBuffer());
        return entry.type === 'jpeg' ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
      } catch (_) { /* unusual file: fall back to the canvas path below */ }
    }
    const { bytes, format } = await renderToBytes(entry, layout, s);
    return format === 'png' ? pdfDoc.embedPng(bytes) : pdfDoc.embedJpg(bytes);
  }

  /** Builds the PDF and returns it as a Blob. */
  async function generatePDF() {
    if (!state.images.length) throw new UserError('Add at least one image before creating a PDF.');
    if (!window.PDFLib) throw new UserError('The PDF engine couldn’t be loaded. Check your connection and reload the page.');

    const { PDFDocument } = window.PDFLib;
    const s = { ...state.settings };
    const images = state.images.slice();
    const total = images.length;

    setProgress(2, 'Preparing images…');
    await nextFrame();
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setCreator('X PDF');
    pdfDoc.setProducer('X PDF');

    // One page per image, in the order shown in the editor.
    for (let i = 0; i < total; i++) {
      const entry = images[i];
      setProgress(5 + (i / total) * 88, `Page ${i + 1} of ${total}`);
      await nextFrame(); // let the progress bar repaint

      try {
        const layout = computeLayout(entry, s);
        const embedded = await embedImage(pdfDoc, entry, layout, s);
        const page = pdfDoc.addPage([layout.pageW, layout.pageH]);
        // PDF coordinates start at the bottom-left, so flip the y position.
        page.drawImage(embedded, {
          x: layout.box.x,
          y: layout.pageH - layout.box.y - layout.box.h,
          width: layout.box.w,
          height: layout.box.h,
        });
      } catch (err) {
        console.error(err);
        if (err instanceof UserError) throw err;
        if (err && (err.name === 'RangeError' || /memory|allocat/i.test(String(err.message)))) throw err;
        throw new UserError(`“${entry.name}” couldn’t be added to the PDF. Remove it and try again.`);
      }
    }

    setProgress(95, 'Creating PDF…');
    await nextFrame();
    const bytes = await pdfDoc.save();
    setProgress(100, 'Creating PDF…');
    return new Blob([bytes], { type: 'application/pdf' });
  }

  /** Saves the generated PDF through a temporary download link. */
  function downloadPDF() {
    if (!state.result) return;
    const url = URL.createObjectURL(state.result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.result.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function setBusy(busy) {
    state.busy = busy;
    els.downloadBtn.disabled = busy;
    els.downloadBtn.classList.toggle('is-busy', busy);
    els.downloadBtn.setAttribute('aria-busy', String(busy));
    els.colMain.inert = busy;
    els.settingsPanel.inert = busy;
    els.filename.disabled = busy;
  }

  /** Click handler for the main "Download PDF" button. */
  async function createAndDownload() {
    if (state.busy) return;
    if (!state.images.length) { showError('Add at least one image before creating a PDF.'); return; }

    clearErrors();
    setBusy(true);
    els.progress.hidden = false;
    setProgress(0, 'Preparing images…');
    els.downloadLabel.textContent = 'Creating PDF…';

    try {
      const blob = await generatePDF();
      state.result = {
        blob,
        name: `${currentFilename()}.pdf`,
        count: state.images.length,
        size: blob.size,
      };
      els.downloadLabel.textContent = 'PDF Ready ✓';
      downloadPDF();
      await delay(650);
      showSuccess();
    } catch (err) {
      console.error(err);
      showError(friendlyMessage(err));
    } finally {
      setBusy(false);
      els.progress.hidden = true;
      els.downloadLabel.textContent = 'Download PDF';
    }
  }

  /* ------------------------------------------------------------
   * Success + reset
   * ---------------------------------------------------------- */
  function showSuccess() {
    const r = state.result;
    els.successText.textContent = `${plural(r.count, 'image')} successfully converted.`;
    els.successFile.textContent = `${r.name} · ${formatBytes(r.size)}`;
    setView('success');
    window.scrollTo({ top: 0 });
    els.successTitle.focus({ preventScroll: true });
    announce('Your PDF is ready and has been downloaded.');
  }

  function resetApp() {
    state.images.forEach((i) => URL.revokeObjectURL(i.url));
    state.images = [];
    state.result = null;
    previewToken++;
    els.imageList.replaceChildren();
    els.previewGrid.replaceChildren();
    els.filename.value = DEFAULT_FILENAME;
    clearErrors();
    setView('empty');
    window.scrollTo({ top: 0 });
    els.chooseBtn.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------
   * Event wiring
   * ---------------------------------------------------------- */
  const openPicker = () => { if (!state.busy) els.fileInput.click(); };

  els.chooseBtn.addEventListener('click', openPicker);
  els.addMoreBtn.addEventListener('click', openPicker);
  els.dropzone.addEventListener('click', (e) => { if (!e.target.closest('button')) openPicker(); });
  els.fileInput.addEventListener('change', () => {
    const files = Array.from(els.fileInput.files);
    els.fileInput.value = ''; // allows picking the same file again
    handleFiles(files);
  });

  // Drag & drop files anywhere on the page.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const canAcceptDrop = () => !state.busy && state.view !== 'success';
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (canAcceptDrop()) document.body.classList.add('is-dragover');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = canAcceptDrop() ? 'copy' : 'none';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('is-dragover');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // stop the browser from opening the file
    dragDepth = 0;
    document.body.classList.remove('is-dragover');
    if (canAcceptDrop()) handleFiles(e.dataTransfer.files);
  });

  // Image card actions (event delegation).
  els.imageList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = Number(btn.closest('.image-card').dataset.id);
    switch (btn.dataset.action) {
      case 'up': moveImage(id, -1, '[data-action="up"]'); break;
      case 'down': moveImage(id, 1, '[data-action="down"]'); break;
      case 'rotate': rotateImage(id); break;
      case 'remove': removeImage(id); break;
    }
  });
  els.imageList.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.card-handle');
    if (handle) startPointerDrag({ ...proxyEvent(e), currentTarget: handle }, handle.closest('.image-card'));
  });
  els.imageList.addEventListener('keydown', (e) => {
    const handle = e.target.closest('.card-handle');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    moveImage(Number(handle.closest('.image-card').dataset.id), e.key === 'ArrowUp' ? -1 : 1, '.card-handle');
  });
  // startPointerDrag needs a few event fields plus preventDefault; wrap them.
  function proxyEvent(e) {
    return {
      pointerId: e.pointerId, pointerType: e.pointerType, button: e.button, clientY: e.clientY,
      preventDefault: () => e.preventDefault(),
    };
  }

  // Settings.
  els.pageSize.addEventListener('change', updateSettings);
  document.querySelectorAll('input[name="orientation"], input[name="fit"]').forEach((r) => r.addEventListener('change', updateSettings));
  els.margin.addEventListener('input', updateSettings);
  els.quality.addEventListener('input', updateSettings);

  // Filename: silently drop invalid characters.
  els.filename.addEventListener('input', () => {
    const cleaned = els.filename.value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '');
    if (cleaned !== els.filename.value) els.filename.value = cleaned;
  });
  els.filename.addEventListener('blur', () => { els.filename.value = currentFilename(); });
  els.filename.addEventListener('keydown', (e) => { if (e.key === 'Enter') createAndDownload(); });

  els.downloadBtn.addEventListener('click', createAndDownload);
  els.downloadAgainBtn.addEventListener('click', downloadPDF);
  els.resetBtn.addEventListener('click', resetApp);

  /* ------------------------------------------------------------
   * Init
   * ---------------------------------------------------------- */
  readSettings();
  syncSettings();
  setView('empty');
})();
