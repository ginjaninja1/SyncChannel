define([], function () {
    'use strict';

    // ===================================================================
    // Client-side cache of the last DiscoverFields result per
    // connection+schema pair, so switching rule sets or toggling a
    // favorite doesn't re-hit the network — only a genuinely new
    // connection/schema pairing, or an explicit Refresh, does.
    // ===================================================================
    var discoveredFieldsCache = {};

    function discoveryCacheKey(connectionId, schemaId) { return connectionId + '|' + schemaId; }

    function setDiscoveredFields(connectionId, schemaId, fields) {
        discoveredFieldsCache[discoveryCacheKey(connectionId, schemaId)] = fields;
    }

    function getDiscoveredFields(connectionId, schemaId) {
        return discoveredFieldsCache[discoveryCacheKey(connectionId, schemaId)] || null;
    }

    // schemaFields()/fieldTypeInSchema() removed — they read schema.Fields,
    // which the palette no longer sources from. This reads the same
    // discoveredFieldsCache the palette/schema editor populate. Pure
    // function — takes connectionId/schemaId explicitly rather than
    // reading DOM selects itself, so callers control exactly which
    // selection it resolves against (matters once a stale async response
    // could otherwise race a newer one).
    function fieldTypeFromDiscovery(connectionId, schemaId, fieldPath) {
        var fields = getDiscoveredFields(connectionId, schemaId);
        if (!fields) return 'String';
        var f = fields.filter(function (x) { return x.JsonPath === fieldPath; })[0];
        return f ? f.Type : 'String';
    }

    function discoveredPath(fields, expectedPath) {
        var match = (fields || []).filter(function (field) {
            return (field.JsonPath || '').toLowerCase() === expectedPath.toLowerCase();
        })[0];
        return match ? match.JsonPath : '';
    }

    function suggestRoleField(fields, patterns) {
        for (var p = 0; p < patterns.length; p++) {
            var match = fields.filter(function (f) {
                return patterns[p].test(f.JsonPath) || patterns[p].test(f.DisplayName || '');
            })[0];
            if (match) return match.JsonPath;
        }
        return '';
    }

    // ---- Stale-response guard ----
    // Every async discovery/fetch call site used to hand-roll its own
    // "requestToken !== someCounter" check. One guard, one behavior:
    // create() returns a token generator; a request is stale once a newer
    // one has been issued from the same guard.
    function createRequestGuard() {
        var currentToken = 0;
        return {
            next: function () { return ++currentToken; },
            isStale: function (token) { return token !== currentToken; }
        };
    }

    return {
        setDiscoveredFields: setDiscoveredFields,
        getDiscoveredFields: getDiscoveredFields,
        fieldTypeFromDiscovery: fieldTypeFromDiscovery,
        discoveredPath: discoveredPath,
        suggestRoleField: suggestRoleField,
        createRequestGuard: createRequestGuard
    };
});
