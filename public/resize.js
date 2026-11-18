'use strict';

// Resizable columns for the editor: drag the dividers between Files, the code editor and the console panel.
// The width maths is plain functions (tested in Node); the browser part wires pointer, keyboard and double-click.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CCResize = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_SIDE = 160;
  const MAX_SIDE = 520;
  const MIN_PANEL = 280;
  const MIN_EDITOR = 280; // the code editor never gets narrower than this
  const RAIL_SIDE = 48; // a collapsed Files column
  const RAIL_PANEL = 44; // a collapsed console column
  const KEY_STEP = 16;
  const KEY_STEP_BIG = 48;

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  /**
   * The widest the Files column may be: the row minus the console column and the editor's minimum, capped.
   * `panelWidth` is 0 when the console is stacked under the editor (narrow windows).
   */
  function sideRoom(rowWidth, panelWidth) {
    return Math.min(MAX_SIDE, rowWidth - panelWidth - MIN_EDITOR);
  }

  /** The widest the console column may be: the row minus the Files column and the editor's minimum. */
  function panelRoom(rowWidth, sideWidth) {
    return rowWidth - sideWidth - MIN_EDITOR;
  }

  /** A wanted width, kept between the column's minimum and what is left over (the minimum wins when there is no room). */
  function fit(wanted, min, room) {
    return Math.round(clamp(wanted, min, Math.max(min, room)));
  }

  /** The new width while dragging: `grow` is +1 when dragging right widens the column and -1 when dragging left does. */
  function dragWidth(startWidth, startX, x, grow) {
    return startWidth + grow * (x - startX);
  }

  /**
   * Wire the dividers. `state` holds sideW / panelW (px, 0 = default) and sideOpen / panelOpen; `save` persists it.
   * Returns { apply }: call it after anything that changes which columns are open, or the window size.
   */
  function create({ state, save, body, sidebar, panel, sideHandle, panelHandle, stacked }) {
    const rowWidth = () => body.clientWidth;
    const panelNow = () => (stacked() ? 0 : state.panelOpen ? panel.offsetWidth : RAIL_PANEL);
    const sideNow = () => (state.sideOpen ? sidebar.offsetWidth : RAIL_SIDE);
    const sideLimit = () => sideRoom(rowWidth(), panelNow());
    const panelLimit = () => panelRoom(rowWidth(), sideNow());

    function apply() {
      const css = document.documentElement.style;
      if (state.sideW) css.setProperty('--side-w', `${fit(state.sideW, MIN_SIDE, sideLimit())}px`); else css.removeProperty('--side-w');
      if (state.panelW) {
        css.setProperty('--panel-w', `${fit(state.panelW, MIN_PANEL, panelLimit())}px`);
        css.setProperty('--panel-max', 'none');
      } else {
        css.removeProperty('--panel-w');
        css.removeProperty('--panel-max');
      }
      for (const [handle, column, min, max] of [[sideHandle, sidebar, MIN_SIDE, MAX_SIDE], [panelHandle, panel, MIN_PANEL, 2000]]) {
        handle.setAttribute('aria-valuenow', String(column.offsetWidth));
        handle.setAttribute('aria-valuemin', String(min));
        handle.setAttribute('aria-valuemax', String(max));
      }
    }

    function wire({ handle, column, grow, field, min, limit }) {
      const set = (w) => { state[field] = fit(w, min, limit()); apply(); };
      let startX = 0;
      let startW = 0;

      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        startX = e.clientX;
        startW = column.offsetWidth;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('active');
        document.body.classList.add('resizing');
      });
      handle.addEventListener('pointermove', (e) => {
        if (!handle.hasPointerCapture(e.pointerId)) return;
        set(dragWidth(startW, startX, e.clientX, grow));
      });
      const stop = (e) => {
        if (!handle.hasPointerCapture(e.pointerId)) return;
        handle.releasePointerCapture(e.pointerId);
        handle.classList.remove('active');
        document.body.classList.remove('resizing');
        save();
      };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);

      handle.addEventListener('dblclick', () => { state[field] = 0; apply(); save(); }); // back to the default width
      handle.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
        set(column.offsetWidth + grow * (e.key === 'ArrowRight' ? step : -step));
        save();
      });
    }

    wire({ handle: sideHandle, column: sidebar, grow: 1, field: 'sideW', min: MIN_SIDE, limit: sideLimit });
    wire({ handle: panelHandle, column: panel, grow: -1, field: 'panelW', min: MIN_PANEL, limit: panelLimit });
    window.addEventListener('resize', apply); // keep the editor from being squeezed when the window shrinks
    return { apply };
  }

  return { create, sideRoom, panelRoom, fit, dragWidth, MIN_SIDE, MAX_SIDE, MIN_PANEL, MIN_EDITOR, RAIL_SIDE, RAIL_PANEL };
});
