namespace SyncChannel.Configuration
{
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Serialization;
    using System;
    using System.IO;
    using System.Linq;

    public class ConnectionsStore
    {
        private const string FileName = "connections.json";

        private readonly IApplicationPaths appPaths;
        private readonly IJsonSerializer json;
        private readonly ILogger logger;

        public ConnectionsStore(IApplicationPaths appPaths, IJsonSerializer json, ILogger logger)
        {
            this.appPaths = appPaths;
            this.json = json;
            this.logger = logger;
        }

        private string FilePath => Path.Combine(appPaths.DataPath, "channel-sync", FileName);

        public ConnectionsFile Load()
        {
            var path = FilePath;

            if (!File.Exists(path))
            {
                var seeded = new ConnectionsFile();
                Save(seeded);
                return seeded;
            }

            try
            {
                var file = json.DeserializeFromString<ConnectionsFile>(File.ReadAllText(path));
                return file ?? new ConnectionsFile();
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to read {0} — starting with an empty connections file", ex, path);
                return new ConnectionsFile();
            }
        }

        public void Save(ConnectionsFile file)
        {
            var path = FilePath;
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            File.WriteAllText(path, json.SerializeToString(file));
        }

        public ConnectionEntry Find(string id)
        {
            return Load().Connections.FirstOrDefault(c => string.Equals(c.Id, id, StringComparison.OrdinalIgnoreCase));
        }
    }
}