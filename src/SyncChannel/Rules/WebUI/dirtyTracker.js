define([], function () {
    'use strict';

    // ===================================================================
    // One dirty-tracking implementation for every tab, instead of each tab
    // hand-rolling its own snapshot/compare/discard bookkeeping. Each
    // tracker instance owns one saved-snapshot string; comparison is
    // always "does serialize(current) match the last-saved serialization".
    // ===================================================================

    function createTracker(serialize) {
        var savedSnapshot = null;

        function snapshotSaved(currentValue) {
            savedSnapshot = serialize(currentValue);
        }

        function isDirty(currentValue) {
            return savedSnapshot !== null && serialize(currentValue) !== savedSnapshot;
        }

        function clear() {
            savedSnapshot = null;
        }

        // Wires a warning label + discard button pair to this tracker in
        // one call, so every tab applies the exact same behavior: label
        // text, discard-button enablement, nothing else.
        function refreshUi(view, warningSelector, discardSelector, currentValue) {
            var warning = view.querySelector(warningSelector);
            var discard = discardSelector ? view.querySelector(discardSelector) : null;
            if (!warning) return;
            var dirty = isDirty(currentValue);
            warning.innerText = dirty ? 'Unsaved changes' : '';
            if (discard) discard.disabled = !dirty;
        }

        return {
            snapshotSaved: snapshotSaved,
            isDirty: isDirty,
            clear: clear,
            refreshUi: refreshUi
        };
    }

    return { createTracker: createTracker };
});
