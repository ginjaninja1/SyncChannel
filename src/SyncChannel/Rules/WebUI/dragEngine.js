define([], function () {
    'use strict';

    // ===================================================================
    // Pointer-based drag engine (unchanged mechanics from the original
    // rulesPage.js / folderTreePage.js — native HTML5 DnD is unreliable in
    // Emby's webview, see Evidence.md).
    //
    // Generic on purpose: this module has no knowledge of rule builder or
    // schema mapping concepts. Consumers register drop targets with an
    // optional onHover(clientX, clientY) callback to draw their own
    // insertion indicators/highlights; the engine just tracks pointer
    // state and dispatches.
    // ===================================================================
    var dropTargetRegistry = [];
    var activeDrag = null;
    var highlightedTarget = null;
    var dragScrollContainer = null;
    var dragScrollVelocity = 0;
    var dragScrollFrame = null;
    var insertionIndicatorEl = null;

    function resetDragEngine() {
        dropTargetRegistry = [];
        activeDrag = null;
        highlightedTarget = null;
    }

    // onHover(clientX, clientY, reorderElement) — optional, called on every
    // pointermove while this target is the current drop candidate.
    // reorderElement is whatever the drag source's reorderElFn returned (or
    // null for a fresh palette drag) — consumers doing horizontal-chip
    // reordering need it to exclude the chip being moved from their own
    // insertion-point math; consumers that don't care can ignore it.
    function registerDropTarget(el, kinds, onDrop, highlightClass, onHover) {
        dropTargetRegistry.push({
            el: el,
            kinds: kinds,
            onDrop: onDrop,
            highlightClass: highlightClass || 'rcsDragOver',
            onHover: onHover || null
        });
    }

    function makeDraggableSource(el, kind, valueFn, reorderElFn) {
        el.style.touchAction = 'none';
        el.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            if (e.target.closest && e.target.closest('input,select,textarea,button,a,.esMapSegRemove')) return;
            if (activeDrag) {
                // A previous drag never got a matching pointerup/cancel (e.g.
                // released over UI that swallowed the event) — clean it up
                // before starting a new one instead of stacking ghosts.
                teardownDrag();
            }
            e.preventDefault();
            var value = typeof valueFn === 'function' ? valueFn() : (valueFn || '');
            var reorderEl = typeof reorderElFn === 'function' ? reorderElFn() : (reorderElFn || null);
            startPointerDrag(e, kind, value, reorderEl, el);
        });
    }

    function startPointerDrag(e, kind, value, reorderElement, sourceEl) {
        var ghost = document.createElement('div');
        ghost.className = 'rcsDragGhost';
        ghost.innerText = (sourceEl && sourceEl.dataset.dragLabel) ||
            value || (sourceEl ? sourceEl.innerText : kind);
        document.body.appendChild(ghost);

        activeDrag = { kind: kind, value: value, reorderElement: reorderElement, ghostEl: ghost };
        dragScrollContainer = findDragScrollContainer(sourceEl);
        positionGhost(e.clientX, e.clientY);

        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerCancel, true);
        window.addEventListener('blur', onWindowBlurDuringDrag);
    }

    function positionGhost(x, y) {
        if (!activeDrag) return;
        activeDrag.ghostEl.style.left = (x + 14) + 'px';
        activeDrag.ghostEl.style.top = (y + 14) + 'px';
    }

    function findDragScrollContainer(sourceEl) {
        var el = sourceEl && sourceEl.parentElement;
        while (el && el !== document.body) {
            var style = window.getComputedStyle(el);
            if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function updateDragEdgeScroll(clientY) {
        if (!dragScrollContainer) return;
        var isDocument = dragScrollContainer === document.scrollingElement ||
            dragScrollContainer === document.documentElement ||
            dragScrollContainer === document.body;
        var rect = isDocument
            ? { top: 0, bottom: window.innerHeight }
            : dragScrollContainer.getBoundingClientRect();
        var edge = Math.min(90, Math.max(50, (rect.bottom - rect.top) * 0.12));

        if (clientY < rect.top + edge) {
            dragScrollVelocity = -Math.ceil(18 * (rect.top + edge - clientY) / edge);
        } else if (clientY > rect.bottom - edge) {
            dragScrollVelocity = Math.ceil(18 * (clientY - (rect.bottom - edge)) / edge);
        } else {
            dragScrollVelocity = 0;
        }

        if (dragScrollVelocity && !dragScrollFrame) {
            dragScrollFrame = requestAnimationFrame(runDragEdgeScroll);
        }
    }

    function runDragEdgeScroll() {
        dragScrollFrame = null;
        if (!activeDrag || !dragScrollContainer || !dragScrollVelocity) return;
        var isDocument = dragScrollContainer === document.scrollingElement ||
            dragScrollContainer === document.documentElement ||
            dragScrollContainer === document.body;
        if (isDocument) window.scrollBy(0, dragScrollVelocity);
        else dragScrollContainer.scrollTop += dragScrollVelocity;
        dragScrollFrame = requestAnimationFrame(runDragEdgeScroll);
    }

    function ensureInsertionIndicator() {
        if (!insertionIndicatorEl) {
            insertionIndicatorEl = document.createElement('div');
            insertionIndicatorEl.className = 'rcsInsertionIndicator';
            document.body.appendChild(insertionIndicatorEl);
        }
        return insertionIndicatorEl;
    }

    function hideInsertionIndicator() {
        if (insertionIndicatorEl) insertionIndicatorEl.style.display = 'none';
    }

    // Vertical insertion indicator for a plain top-to-bottom list container
    // (e.g. rule builder's group children). Callers with different layouts
    // (e.g. schema mapping's horizontal chip row) draw their own indicator
    // via ensureInsertionIndicator()/hideInsertionIndicator() instead.
    function showInsertionIndicatorAt(containerEl, clientY) {
        var insertBeforeEl = findInsertionPoint(containerEl, clientY);
        var y;

        if (insertBeforeEl) {
            y = insertBeforeEl.getBoundingClientRect().top;
        } else {
            var items = Array.prototype.filter.call(containerEl.children, function (el) {
                return el.classList.contains('rcsCondition') || el.classList.contains('rcsGroup');
            });
            if (items.length) {
                y = items[items.length - 1].getBoundingClientRect().bottom;
            } else {
                y = containerEl.getBoundingClientRect().top + 8;
            }
        }

        var containerRect = containerEl.getBoundingClientRect();
        var indicator = ensureInsertionIndicator();
        indicator.style.display = 'block';
        indicator.style.left = containerRect.left + 'px';
        indicator.style.width = containerRect.width + 'px';
        indicator.style.height = '3px';
        indicator.style.top = (y - 2) + 'px';
    }

    function findDropTarget(x, y) {
        if (!activeDrag) return null;
        var elAtPoint = document.elementFromPoint(x, y);
        if (!elAtPoint) return null;

        var matches = dropTargetRegistry.filter(function (reg) {
            return reg.kinds.indexOf(activeDrag.kind) !== -1 &&
                (reg.el === elAtPoint || reg.el.contains(elAtPoint));
        });

        if (matches.length === 0) return null;
        if (matches.length === 1) return matches[0];

        for (var i = 0; i < matches.length; i++) {
            var isMostNested = true;
            for (var j = 0; j < matches.length; j++) {
                if (i !== j && matches[i].el !== matches[j].el && matches[i].el.contains(matches[j].el)) {
                    isMostNested = false;
                    break;
                }
            }
            if (isMostNested) return matches[i];
        }
        return matches[0];
    }

    function onPointerMove(e) {
        if (!activeDrag) return;
        positionGhost(e.clientX, e.clientY);
        updateDragEdgeScroll(e.clientY);

        var target = findDropTarget(e.clientX, e.clientY);

        if (highlightedTarget && highlightedTarget !== target) {
            highlightedTarget.el.classList.remove(highlightedTarget.highlightClass);
            highlightedTarget = null;
        }
        if (target) {
            target.el.classList.add(target.highlightClass);
            highlightedTarget = target;
        }

        if (target && typeof target.onHover === 'function') {
            target.onHover(e.clientX, e.clientY, activeDrag.reorderElement);
        } else {
            hideInsertionIndicator();
        }
    }

    function onPointerUp(e) {
        if (!activeDrag) return;

        var target = findDropTarget(e.clientX, e.clientY);
        var drag = activeDrag;

        teardownDrag();

        if (target) {
            target.onDrop(drag.value, drag.reorderElement, e.clientY, e.clientX);
        }
    }

    function onPointerCancel() { teardownDrag(); }

    function onWindowBlurDuringDrag() { teardownDrag(); }

    function teardownDrag() {
        if (highlightedTarget) {
            highlightedTarget.el.classList.remove(highlightedTarget.highlightClass);
            highlightedTarget = null;
        }
        hideInsertionIndicator();
        if (activeDrag && activeDrag.ghostEl && activeDrag.ghostEl.parentNode) {
            activeDrag.ghostEl.parentNode.removeChild(activeDrag.ghostEl);
        }
        activeDrag = null;
        dragScrollVelocity = 0;
        dragScrollContainer = null;
        if (dragScrollFrame) {
            cancelAnimationFrame(dragScrollFrame);
            dragScrollFrame = null;
        }
        document.removeEventListener('pointermove', onPointerMove, true);
        document.removeEventListener('pointerup', onPointerUp, true);
        document.removeEventListener('pointercancel', onPointerCancel, true);
        window.removeEventListener('blur', onWindowBlurDuringDrag);
    }

    function findInsertionPoint(container, clientY) {
        var items = Array.prototype.filter.call(container.children, function (el) {
            return el.classList.contains('rcsCondition') || el.classList.contains('rcsGroup');
        });

        for (var i = 0; i < items.length; i++) {
            var rect = items[i].getBoundingClientRect();
            var midpoint = rect.top + rect.height / 2;
            if (clientY < midpoint) {
                return items[i];
            }
        }
        return null;
    }

    return {
        resetDragEngine: resetDragEngine,
        registerDropTarget: registerDropTarget,
        makeDraggableSource: makeDraggableSource,
        findInsertionPoint: findInsertionPoint,
        showInsertionIndicatorAt: showInsertionIndicatorAt,
        ensureInsertionIndicator: ensureInsertionIndicator,
        hideInsertionIndicator: hideInsertionIndicator
    };
});
