using System.Text.Json;
using CUE4Parse.Compression;
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion.Textures;
using SkiaSharp;

/// <summary>
/// Dino Depot Studio asset sidecar.
///
/// Reads the artwork out of a mod already installed on this machine, so an
/// administrator can put a real icon on a creature or item instead of a glyph.
/// Emits NDJSON on stdout, the same shape as the CurseForge scraper sidecar,
/// so the Studio can stream progress rather than wait in silence.
///
/// Modes:
///   textures &lt;mod-paks-dir&gt; &lt;game-paks-dir&gt;
///     Lists every Texture2D in the mod. Events: status, texture, done, error
///
///   export &lt;mod-paks-dir&gt; &lt;game-paks-dir&gt; &lt;asset-path&gt;
///     Decodes one texture and writes it out as base64 PNG.
///     Events: status, image, done, error
///
///   gamelist &lt;any&gt; &lt;game-paks-dir&gt; [filter]
///     Prints base-game asset paths matching a filter, one per line. A
///     diagnostic: reading ARK's own class names beats guessing at them.
///     Events: status, done, error
/// </summary>
internal static class Program
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static void Emit(object payload) =>
        Console.WriteLine(JsonSerializer.Serialize(payload, Json));

    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.Length < 3)
            {
                throw new ArgumentException(
                    "usage: textures <mod-paks> <game-paks> | export <mod-paks> <game-paks> <asset-path>"
                );
            }

            var mode = args[0];
            var modPaks = args[1];
            var gamePaks = args[2];
            await InitializeOodleAsync();
            var provider = OpenMod(modPaks, gamePaks);

            switch (mode)
            {
                case "textures":
                    ListTextures(provider);
                    return 0;
                case "gamelist":
                    ListGameAssets(gamePaks, args.Length > 3 ? args[3] : "");
                    return 0;
                case "export":
                    if (args.Length < 4) throw new ArgumentException("export needs an asset path");
                    ExportTexture(provider, args[3]);
                    return 0;
                default:
                    throw new ArgumentException($"Unknown mode '{mode}'");
            }
        }
        catch (Exception error)
        {
            Emit(new { type = "error", message = error.Message });
            return 1;
        }
    }

    /// <summary>
    /// ASA's containers are Oodle-compressed, and UE5 links Oodle statically
    /// into the game executable - there is no copy in the install to borrow.
    /// The library is fetched once and cached beside this tool.
    /// </summary>
    private static async Task InitializeOodleAsync()
    {
        var path = Path.Combine(AppContext.BaseDirectory, OodleHelper.OODLE_DLL_NAME);
        if (!File.Exists(path))
        {
            Emit(new { type = "status", message = "Fetching the Oodle decompression library…" });
            if (!OodleHelper.DownloadOodleDll(path))
            {
                using var http = new HttpClient();
                await OodleHelper.DownloadOodleDllFromOodleUEAsync(http, path);
            }
        }
        if (!File.Exists(path))
        {
            throw new InvalidOperationException(
                "The Oodle decompression library could not be obtained, so mod artwork cannot be read"
            );
        }
        OodleHelper.Initialize(path);
    }

    /// <summary>
    /// Mounts one mod, plus the game's global container.
    ///
    /// An IoStore package names its classes through `global.utoc`; without it
    /// every asset in the mod fails to parse with "global data is missing".
    /// Only that one file is registered - the hundreds of gigabytes of chunk
    /// containers beside it are not needed to read a mod, and mounting them
    /// would be ruinous.
    /// </summary>
    private static DefaultFileProvider OpenMod(string modPaks, string gamePaks)
    {
        if (!Directory.Exists(modPaks))
        {
            throw new DirectoryNotFoundException($"No mod content at {modPaks}");
        }
        var provider = new DefaultFileProvider(
            modPaks,
            SearchOption.TopDirectoryOnly,
            new VersionContainer(EGame.GAME_UE5_5)
        );
        var global = Path.Combine(gamePaks, "global.utoc");
        if (!File.Exists(global))
        {
            throw new FileNotFoundException(
                $"The game's global.utoc was not found in {gamePaks}"
            );
        }
        provider.RegisterVfs(new FileInfo(global));
        // Once, after everything is registered. Initializing per registration
        // mounts the mod's containers twice and every asset is listed twice.
        provider.Initialize();
        // ASA ships no AES key. The zero key is what unlocks an unencrypted
        // container, rather than a no-op.
        provider.SubmitKey(new FGuid(), new FAesKey(new byte[32]));
        provider.Mount();
        return provider;
    }

    /// <summary>
    /// Every texture the mod carries, without decoding any of them.
    ///
    /// Decoding is what costs - a 4096x4096 surface is tens of megabytes - and
    /// a picker only needs pixels for what is on screen. The type comes from
    /// the package's exports, which is the only thing that reliably tells a
    /// texture from a blueprint: on disk every asset is just a `.uasset`.
    /// </summary>
    private static void ListTextures(DefaultFileProvider provider)
    {
        var packages = provider
            .Files.Where(pair =>
                pair.Key.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)
                // Only the mod's own content. Registering global.utoc brings
                // the engine's own assets along with it.
                && pair.Key.Contains("/Mods/", StringComparison.OrdinalIgnoreCase)
            )
            .ToList();

        Emit(new { type = "status", message = $"Reading {packages.Count} assets…" });
        var found = 0;
        var failed = 0;
        foreach (var (path, file) in packages)
        {
            try
            {
                var package = provider.LoadPackage(file);
                foreach (var export in package.GetExports())
                {
                    if (export is not UTexture2D texture) continue;
                    Emit(
                        new
                        {
                            type = "texture",
                            path,
                            name = texture.Name,
                            width = texture.PlatformData?.SizeX ?? 0,
                            height = texture.PlatformData?.SizeY ?? 0,
                        }
                    );
                    found++;
                    break;
                }
            }
            catch
            {
                // One unreadable asset is not a reason to abandon the mod.
                failed++;
            }
        }
        Emit(new { type = "done", count = found, failed });
    }

    /// <summary>
    /// Every base-game asset path matching a filter.
    ///
    /// Only the container indexes are read, never the data behind them, so
    /// this costs about two seconds over a 300 GB install. It exists because
    /// naming rules about ARK's own classes cannot be trusted - the fertilized
    /// egg mapping in `scripts/data` was read with this rather than guessed.
    /// </summary>
    private static void ListGameAssets(string gamePaks, string filter)
    {
        var provider = new DefaultFileProvider(
            gamePaks,
            SearchOption.TopDirectoryOnly,
            new VersionContainer(EGame.GAME_UE5_5)
        );
        provider.Initialize();
        provider.SubmitKey(new FGuid(), new FAesKey(new byte[32]));
        provider.Mount();

        var hits = provider
            .Files.Keys.Where(key =>
                filter.Length == 0
                || key.Contains(filter, StringComparison.OrdinalIgnoreCase)
            )
            .OrderBy(key => key, StringComparer.OrdinalIgnoreCase)
            .ToList();
        Emit(new { type = "status", message = $"{provider.Files.Count} files indexed" });
        foreach (var hit in hits) Console.WriteLine(hit);
        Emit(new { type = "done", count = hits.Count });
    }

    /// <summary>Decodes one texture and hands back PNG bytes.</summary>
    private static void ExportTexture(DefaultFileProvider provider, string assetPath)
    {
        if (!provider.Files.TryGetValue(assetPath, out var file))
        {
            throw new FileNotFoundException($"No asset at {assetPath}");
        }
        var package = provider.LoadPackage(file);
        foreach (var export in package.GetExports())
        {
            if (export is not UTexture2D texture) continue;
            using var bitmap =
                texture.Decode(ETexturePlatform.DesktopMobile)
                ?? throw new InvalidOperationException($"{texture.Name} could not be decoded");
            using var data = bitmap.Encode(SKEncodedImageFormat.Png, 100);
            Emit(
                new
                {
                    type = "image",
                    name = texture.Name,
                    width = bitmap.Width,
                    height = bitmap.Height,
                    pngB64 = Convert.ToBase64String(data.ToArray()),
                }
            );
            Emit(new { type = "done", count = 1 });
            return;
        }
        throw new InvalidOperationException($"{assetPath} holds no texture");
    }
}
