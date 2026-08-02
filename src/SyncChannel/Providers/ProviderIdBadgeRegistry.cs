// Backs the fixed pool of 5 GenericProviderIdExternalId slot classes.
// Emby composes its IExternalId list once at startup by scanning the
// assembly — it never re-reads config at request time — so these slot
// classes can't take constructor-injected dependencies the way
// EndpointSchemaStore does (Emby instantiates them with no DI, same as
// RadarrExternalId/SonarrExternalId already do). This static registry is
// the bridge: EndpointSchemaStore (which IS DI-constructed and already
// runs on every Load/Save) keeps it refreshed, and each slot class just
// asks it "which key, if any, am I bound to right now" at call time.
//
// No slot binding is persisted anywhere. Slot N is always just "the Nth
// entry, alphabetically, of every currently-enabled non-reserved provider-id
// key across all schemas" — recomputed fresh on every Refresh call. That
// means which physical slot a given key occupies can shift as other keys
// are toggled on/off elsewhere, but that's invisible to the admin (nothing
// in the UI ever surfaces a slot number) and correct: turning a toggle off
// makes its badge disappear immediately, without needing separate cleanup.
namespace SyncChannel.Providers
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using SyncChannel.Configuration;

    public static class ProviderIdBadgeRegistry
    {
        public const int SlotCount = 5;

        private static readonly object SyncRoot = new object();
        private static string[] enabledKeys = Array.Empty<string>();

        // Keyed by provider-id key (same casing rules as enabledKeys). Only
        // populated for keys that have an explicit non-blank template set on
        // SOME schema — first non-blank one found wins if the same key name
        // is reused with different templates across schemas, which would be
        // an odd admin setup but shouldn't throw.
        private static Dictionary<string, string> urlFormatsByKey = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // Only keys this plugin has zero-guessing certainty about: its own
        // compiled IExternalId classes (RadarrExternalId, SonarrExternalId).
        // Deliberately does NOT reserve Tmdb/Imdb/Tvdb or any other
        // Emby-native key — that would require confirmed knowledge of
        // Emby's full built-in IExternalId roster, which this plugin
        // doesn't have. An admin naming a custom field "Tmdb" and enabling
        // our badge for it just produces a harmless duplicate badge
        // alongside Emby's own native one — an acceptable, fail-safe edge
        // case rather than a guess dressed up as a rule. See the matching
        // client-side list in schemaEditorTab.js.
        private static readonly HashSet<string> ReservedKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "RadarrId", "SonarrId"
        };

        public static void Refresh(IEnumerable<EndpointSchema> schemas)
        {
            lock (SyncRoot)
            {
                var schemaList = (schemas ?? Enumerable.Empty<EndpointSchema>()).ToList();

                enabledKeys = schemaList
                    .SelectMany(s => s.BadgeEnabledProviderIdKeys ?? Enumerable.Empty<string>())
                    .Where(k => !string.IsNullOrWhiteSpace(k) && !ReservedKeys.Contains(k))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(k => k, StringComparer.OrdinalIgnoreCase)
                    .ToArray();

                var formats = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var s in schemaList)
                {
                    foreach (var kvp in s.ProviderIdBadgeUrlFormats ?? new Dictionary<string, string>())
                    {
                        if (!string.IsNullOrWhiteSpace(kvp.Value) && !formats.ContainsKey(kvp.Key))
                            formats[kvp.Key] = kvp.Value;
                    }
                }
                urlFormatsByKey = formats;
            }
        }

        public static string KeyForSlot(int slotIndex)
        {
            lock (SyncRoot)
            {
                return slotIndex >= 0 && slotIndex < enabledKeys.Length ? enabledKeys[slotIndex] : null;
            }
        }

        // "{0}" pass-through default — matches RadarrId/SonarrId's existing
        // behavior, where the field is built to already resolve to the
        // complete URL. Only overridden when an admin explicitly set a
        // per-key template (see EndpointSchema.ProviderIdBadgeUrlFormats).
        public static string UrlFormatForSlot(int slotIndex)
        {
            lock (SyncRoot)
            {
                var key = slotIndex >= 0 && slotIndex < enabledKeys.Length ? enabledKeys[slotIndex] : null;
                if (key == null) return "{0}";
                return urlFormatsByKey.TryGetValue(key, out var format) ? format : "{0}";
            }
        }

        public static bool IsReserved(string key) =>
            !string.IsNullOrWhiteSpace(key) && ReservedKeys.Contains(key);

        // Used by the schema editor's toggle to grey out "enable badge" once
        // all 5 slots are taken by OTHER keys — the key already being
        // toggled doesn't count against its own capacity check.
        public static bool IsAtCapacity(string keyBeingConsidered)
        {
            lock (SyncRoot)
            {
                return enabledKeys.Length >= SlotCount &&
                    Array.IndexOf(enabledKeys, keyBeingConsidered) < 0;
            }
        }
    }
}
