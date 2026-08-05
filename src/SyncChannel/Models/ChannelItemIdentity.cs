namespace SyncChannel.Models
{
    using System;

    /// <summary>
    /// Builds the identity Emby receives for a foreign object. Endpoint
    /// schemas map only the source system's raw object id; the connection id
    /// supplies the identity domain so equal ids from different systems can
    /// never share Emby's id-only media callback cache.
    /// </summary>
    public static class ChannelItemIdentity
    {
        private const string Prefix = "syncchannel::";

        public static string Build(string connectionId, string sourceObjectId)
        {
            if (string.IsNullOrWhiteSpace(connectionId) || string.IsNullOrWhiteSpace(sourceObjectId))
            {
                return string.Empty;
            }

            return Prefix + connectionId.Trim() + "::" + sourceObjectId.Trim();
        }
    }
}
