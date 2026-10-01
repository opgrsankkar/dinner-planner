// Plain browser JavaScript loaded with addScriptTag: no TSX function serialization.
(() => {
  const pending = new WeakMap();
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const read = field => {
    const style = getComputedStyle(field);
    return {
      color: style.color, underline: style.backgroundSize, outline: style.outlineStyle,
      borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
      shadow: style.boxShadow, transform: style.transform,
      transitionProperty: style.transitionProperty, transitionDuration: style.transitionDuration,
    };
  };
  const settle = async field => {
    await Promise.all(field.getAnimations().map(animation => animation.finished.catch(() => {})));
    await frame();
    return read(field);
  };
  const waitForStart = async (field, property, previous) => {
    const deadline = performance.now() + 500;
    // Native listeners can run before React's delegated handler. Observe the
    // animation itself, allowing at most twelve frames for that handler to run.
    for (let attempt = 0; attempt <= 12; attempt++) {
      read(field); // Flush pending styles, including newly created transitions.
      const animation = field.getAnimations().find(candidate =>
        !previous.has(candidate) && candidate.playState !== 'idle' &&
        candidate.effect instanceof KeyframeEffect &&
        candidate.effect.getKeyframes().some(keyframe => property in keyframe));
      if (animation) return animation;
      if (attempt === 12 || performance.now() >= deadline) break;
      await frame();
    }
    throw new Error(`Missing new ${property} animation after bounded frame wait: ${JSON.stringify(read(field))}`);
  };
  const collect = async (field, property, previous) => {
    const seen = new Set(previous);
    let animation = await waitForStart(field, property, seen);
    let duration = Number(animation.effect.getTiming().duration);
    let samples = [];
    const deadline = performance.now() + 2000;
    while (true) {
      if (performance.now() > deadline) throw new Error(`${property} animation did not settle`);
      samples.push({ time: Number(animation.currentTime ?? 0), ...read(field) });
      if (animation.playState === 'idle') {
        if (property !== 'backgroundSize') throw new Error(`${property} animation was unexpectedly cancelled`);
        // Chromium's native time segments can briefly blur/refocus the host,
        // replacing its transition. Require a new transition to actually finish.
        seen.add(animation);
        animation = await waitForStart(field, property, seen);
        duration = Number(animation.effect.getTiming().duration);
        // Assertions must prove intermediates in the final completed transition,
        // not borrow samples from a cancelled transient transition.
        samples = [];
        continue;
      }
      if (animation.playState === 'finished') {
        await frame();
        if (animation.playState === 'idle') continue;
        samples.push({ time: Number(animation.currentTime), ...read(field) });
        break;
      }
      await frame();
    }
    return { duration, samples, final: read(field) };
  };
  const arm = (field, event, property) => {
    const target = event === 'submit' ? field.form : field;
    const previous = new Set(field.getAnimations());
    pending.set(field, new Promise((resolve, reject) => {
      target.addEventListener(event, () => {
        // The microtask starts observation; it does not imply React has run.
        queueMicrotask(() => collect(field, property, previous).then(resolve, reject));
      }, { once: true });
    }));
  };
  const untilTime = async (field, time) => {
    const animation = field.getAnimations().find(candidate => candidate.effect instanceof KeyframeEffect &&
      candidate.effect.getKeyframes().some(keyframe => 'color' in keyframe));
    if (!animation) throw new Error('Missing color feedback before repeated submit');
    while (Number(animation.currentTime ?? 0) < time && animation.playState === 'running') await frame();
  };
  window.folioInputSmoke = { read, settle, arm, result: field => pending.get(field), untilTime };
})();
