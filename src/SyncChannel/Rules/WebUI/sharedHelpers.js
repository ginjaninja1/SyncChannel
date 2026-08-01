define([], function () {
    'use strict';

    // ===================================================================
    // Shared operator metadata. Field-level types come from each
    // EndpointSchema's discovered Fields list (server-driven) — only the
    // operator set per abstract type stays as client-side metadata, since
    // it's about the rule builder's UI, not any one provider's schema.
    // ===================================================================
    var OPERATORS_BY_TYPE = {
        Bool: ['EQ'],
        Number: ['LT', 'LTE', 'GT', 'GTE', 'EQ', 'NEQ'],
        Date: ['LT', 'LTE', 'GT', 'GTE', 'EQ', 'NEQ'],
        String: ['EQ', 'NEQ', 'CONTAINS', 'NOTCONTAINS', 'STARTSWITH', 'ENDSWITH'],
        List: ['CONTAINS', 'NOTCONTAINS']
    };

    var ALL_OPERATORS = ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS', 'NOTCONTAINS', 'STARTSWITH', 'ENDSWITH'];

    function operatorAllowedForField(fieldType, operator) {
        var allowed = OPERATORS_BY_TYPE[fieldType];
        return !allowed || allowed.indexOf(operator) !== -1;
    }

    function newId() {
        return 'xxxxxxxxxxxx'.replace(/x/g, function () {
            return (Math.random() * 16 | 0).toString(16);
        });
    }

    // Clipboard.writeText is unavailable on many Emby installs because the
    // web UI is served over plain HTTP. The older selection-based API still
    // works there when called directly from the user's click.
    function copyTextToClipboard(text) {
        function legacyCopy() {
            return new Promise(function (resolve, reject) {
                var textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                var copied = false;
                try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
                document.body.removeChild(textarea);
                if (copied) resolve();
                else reject(new Error('Clipboard copy was rejected by the browser.'));
            });
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).catch(function () {
                return legacyCopy();
            });
        }
        return legacyCopy();
    }

    function connectionBadgeGlyph(c) {
        if (c.LastTestSucceeded === true) return '\u2705';
        if (c.LastTestSucceeded === false) return '\u274C';
        return '\u26AA';
    }

    function connectionBadgeText(c) {
        var glyph = connectionBadgeGlyph(c);
        if (!c.LastTestedUtc) return glyph + ' untested';
        var when = new Date(c.LastTestedUtc);
        return glyph + ' ' + (c.LastTestSucceeded ? 'reachable' : 'unreachable') + ' (' + when.toLocaleString() + ')';
    }

    return {
        ALL_OPERATORS: ALL_OPERATORS,
        operatorAllowedForField: operatorAllowedForField,
        newId: newId,
        copyTextToClipboard: copyTextToClipboard,
        connectionBadgeGlyph: connectionBadgeGlyph,
        connectionBadgeText: connectionBadgeText
    };
});
