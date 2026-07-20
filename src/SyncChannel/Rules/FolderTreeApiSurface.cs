namespace SyncChannel.Rules
{
    using SyncChannel.Configuration;
    using SyncChannel.Fetching;
    using MediaBrowser.Model.Services;
    using System.Collections.Generic;
    using System.Linq;

    [Route("/ChannelSync/FolderTree", "GET", Summary = "Gets the full admin folder tree")]
    public class GetFolderTree : IReturn<FolderTreeFile> { }

    [Route("/ChannelSync/FolderTree", "POST", Summary = "Saves the full admin folder tree")]
    public class SaveFolderTree : IReturn<object>
    {
        public FolderNode RootFolder { get; set; }
    }

    [Route("/ChannelSync/FetchProviders", "GET", Summary = "Lists available fetch providers and their field schemas")]
    public class GetFetchProviders : IReturn<List<ProviderSchemaDto>> { }

    [Route("/ChannelSync/RadarrRuleSetOptions", "GET", Summary = "Lists saved Radarr rule sets, for the RuleSetPicker field type")]
    public class GetRadarrRuleSetOptions : IReturn<List<RuleSetOptionDto>> { }

    public class ProviderSchemaDto
    {
        public string ProviderKey { get; set; }
        public string DisplayName { get; set; }
        public List<FieldSchemaDto> Fields { get; set; } = new List<FieldSchemaDto>();
    }

    public class FieldSchemaDto
    {
        public string Key { get; set; }
        public string DisplayName { get; set; }
        public string Description { get; set; }
        public string Type { get; set; }
        public bool Required { get; set; }
        public string DefaultValue { get; set; }
    }

    public class RuleSetOptionDto
    {
        public string Id { get; set; }
        public string Name { get; set; }
    }

    public class FolderTreeApiSurface : IService
    {
        private readonly FolderTreeStore treeStore;
        private readonly FetchProviderRegistry registry;
        private readonly RadarrRuleSetStore ruleSetStore;

        public FolderTreeApiSurface(FolderTreeStore treeStore, FetchProviderRegistry registry, RadarrRuleSetStore ruleSetStore)
        {
            this.treeStore = treeStore;
            this.registry = registry;
            this.ruleSetStore = ruleSetStore;
        }

        public object Get(GetFolderTree request) => treeStore.Load();

        public object Post(SaveFolderTree request)
        {
            // Root must always survive as root regardless of what the
            // client sent — defence against a client-side bug ever being
            // able to orphan the whole tree by omitting IsRoot.
            request.RootFolder.IsRoot = true;

            treeStore.Save(new FolderTreeFile { RootFolder = request.RootFolder });
            return new { Success = true };
        }

        public object Get(GetFetchProviders request)
        {
            return registry.All.Select(p => new ProviderSchemaDto
            {
                ProviderKey = p.ProviderKey,
                DisplayName = p.DisplayName,
                Fields = p.GetFieldSchema().Select(f => new FieldSchemaDto
                {
                    Key = f.Key,
                    DisplayName = f.DisplayName,
                    Description = f.Description,
                    Type = f.Type.ToString(),
                    Required = f.Required,
                    DefaultValue = f.DefaultValue
                }).ToList()
            }).ToList();
        }

        public object Get(GetRadarrRuleSetOptions request)
        {
            var file = ruleSetStore.Load();
            return file.RuleSets.Select(r => new RuleSetOptionDto { Id = r.Id, Name = r.Name }).ToList();
        }
    }
}
