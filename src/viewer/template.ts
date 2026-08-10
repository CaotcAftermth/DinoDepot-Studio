/**
 * The public cluster viewer ("Production Atlas"): a modern, Ark-themed,
 * single-file HTML page published to GitHub Pages. It fetches the
 * viewer-data JSON at runtime, so republishing the data updates the page
 * without touching the HTML. Creature/item images load from the repo's
 * published images/ folder with emoji fallback.
 */

export interface ViewerPageConfig {
  clusterName: string;
  dataUrl: string;
  /** Base URL of the published images folder ("" disables real images). */
  imagesUrl: string;
}

export function buildViewerHtml(config: ViewerPageConfig): string {
  const cluster = escapeHtml(config.clusterName || "ASA Cluster");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${cluster} — Dino Depot Production Atlas</title>
<style>
:root{
  --bg:#070c12;--bg2:#0a1119;--panel:#0c141d;--panel2:#101a25;--panel3:#15202d;
  --line:#16222f;--line2:#24384a;
  --cyan:#3fd6f2;--cyan2:#8ae9ff;--green:#5be49b;--gold:#e8c15a;--red:#f27d72;
  --violet:#b49af5;
  --text:#dbe7f0;--dim:#7d93a5;--faint:#4c6273;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scrollbar-color:var(--line2) transparent;scroll-behavior:smooth}
body{
  background:
    radial-gradient(900px 420px at 15% -5%, rgba(63,214,242,.07), transparent 60%),
    radial-gradient(900px 420px at 85% -5%, rgba(91,228,155,.05), transparent 60%),
    linear-gradient(var(--bg), var(--bg2));
  color:var(--text);
  font:14.5px/1.55 "Segoe UI",system-ui,sans-serif;
  min-height:100vh;
}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
input{font:inherit}
img{display:block}
.wrap{max-width:1280px;margin:0 auto;padding:0 20px}

/* ---------- header ---------- */
.hdr{
  position:sticky;top:0;z-index:40;border-bottom:1px solid var(--line);
  background:rgba(7,12,18,.92);backdrop-filter:blur(8px);
}
.hdr-in{display:flex;align-items:center;gap:22px;height:60px}
.brand{display:flex;align-items:center;gap:11px;flex:none}
.brand .logo{width:34px;height:34px;object-fit:contain}
.brand .logo-fallback{
  width:34px;height:34px;display:grid;place-items:center;font-size:20px;
  border:1px solid var(--line2);border-radius:8px;color:var(--cyan);
}
.brand .t1{font-size:16px;font-weight:800;letter-spacing:.08em;color:#fff;line-height:1.1}
.brand .t2{font-size:9.5px;letter-spacing:.3em;color:var(--cyan);font-weight:700}
.nav{display:flex;gap:2px;flex:1}
.nav button{
  padding:20px 15px;font-size:12px;font-weight:700;letter-spacing:.14em;
  color:var(--dim);border-bottom:2px solid transparent;text-transform:uppercase;
}
.nav button:hover{color:var(--text)}
.nav button.on{color:var(--cyan);border-bottom-color:var(--cyan)}
.hdr .pill{
  flex:none;font-size:11px;color:var(--dim);border:1px solid var(--line2);
  border-radius:99px;padding:5px 12px;
}
.hdr .pill b{color:var(--green);font-weight:600}

/* ---------- overview ---------- */
.tag{color:var(--dim);text-align:center;margin:22px 0 4px;font-style:italic}
.hero{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}
.hero .panel{
  background:linear-gradient(150deg,var(--panel2),var(--panel));
  border:1px solid var(--line);border-radius:14px;padding:24px;
}
.hero .panel.res{background:
  linear-gradient(150deg,rgba(91,228,155,.05),transparent 45%),
  linear-gradient(150deg,var(--panel2),var(--panel))}
.hero .panel.cre{background:
  linear-gradient(150deg,rgba(63,214,242,.06),transparent 45%),
  linear-gradient(150deg,var(--panel2),var(--panel))}
.hero .hex{
  width:44px;height:44px;display:grid;place-items:center;font-size:22px;
  border:1px solid var(--line2);border-radius:10px;margin-bottom:12px;
}
.hero h2{font-size:20px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
.hero .cre h2{color:var(--cyan2)}
.hero .res h2{color:var(--green)}
.hero p{color:var(--dim);font-size:13px;margin:6px 0 14px}
.searchrow{display:flex;align-items:center;gap:9px;background:var(--bg);
  border:1px solid var(--line2);border-radius:10px;padding:10px 14px}
.searchrow:focus-within{border-color:var(--cyan)}
.searchrow input{flex:1;background:none;border:0;outline:0;color:var(--text)}
.searchrow .go{color:var(--cyan);font-weight:700}
.pop{margin-top:14px}
.pop .lbl{font-size:10px;letter-spacing:.2em;color:var(--faint);font-weight:700;margin-bottom:7px}
.chipset{display:flex;flex-wrap:wrap;gap:6px}
.tagchip{
  font-size:12px;color:var(--dim);border:1px solid var(--line2);
  border-radius:7px;padding:4px 11px;
}
.tagchip:hover{color:var(--cyan);border-color:var(--cyan)}
.stats{
  display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0;
}
.stat{
  display:flex;align-items:center;gap:14px;background:var(--panel);
  border:1px solid var(--line);border-radius:14px;padding:16px 20px;
}
.stat .ic{font-size:24px;color:var(--cyan)}
.stat .v{font-size:26px;font-weight:800;color:#fff;line-height:1.1}
.stat .l{font-size:10px;letter-spacing:.18em;color:var(--dim);font-weight:700;text-transform:uppercase}
.footnote{
  display:flex;gap:26px;justify-content:center;color:var(--faint);font-size:12px;
  border-top:1px solid var(--line);margin-top:26px;padding:18px 0 34px;flex-wrap:wrap;
}

/* ---------- browse views ---------- */
.browse{display:grid;grid-template-columns:minmax(340px,5fr) minmax(380px,4fr);
  gap:14px;align-items:start;margin:18px 0 50px}
.listcol .tools{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.listcol .tools input{
  flex:1;min-width:180px;background:var(--panel);border:1px solid var(--line2);
  border-radius:10px;color:var(--text);padding:9px 13px;outline:0;
}
.listcol .tools input:focus{border-color:var(--cyan)}
.listcol .tools select{
  background:var(--panel);border:1px solid var(--line2);border-radius:10px;
  color:var(--text);padding:9px 10px;outline:0;font:inherit;max-width:170px;
}
.toggle{
  border:1px solid var(--line2);border-radius:10px;padding:9px 13px;
  color:var(--dim);font-size:12.5px;white-space:nowrap;
}
.toggle:hover{color:var(--text)}
.toggle.on{color:var(--cyan);border-color:var(--cyan);background:rgba(63,214,242,.08)}
.found{font-size:11px;color:var(--faint);letter-spacing:.1em;margin-bottom:8px}
.rows{display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 210px);
  overflow-y:auto;padding-right:4px}
.row{
  display:flex;align-items:center;gap:13px;text-align:left;width:100%;
  background:linear-gradient(150deg,var(--panel2),var(--panel));
  border:1px solid var(--line);border-radius:12px;padding:10px 14px;transition:.12s;
}
.row:hover{border-color:var(--line2)}
.row.on{border-color:var(--cyan);box-shadow:0 0 0 1px rgba(63,214,242,.25)}
.avatar{
  width:44px;height:44px;flex:none;border-radius:10px;border:1px solid var(--line2);
  background:var(--bg);display:grid;place-items:center;font-size:22px;overflow:hidden;
}
.avatar img{width:100%;height:100%;object-fit:cover}
.row .mid{flex:1;min-width:0}
.row .nm{font-weight:700;font-size:14.5px;color:#fff}
.row .ct{font-size:11px;color:var(--faint);letter-spacing:.06em}
.row .prod{display:flex;gap:4px;flex:none;align-items:center;flex-wrap:wrap;
  justify-content:flex-end;max-width:46%}
.mini{
  width:26px;height:26px;border-radius:7px;border:1px solid var(--line);
  background:var(--bg);display:grid;place-items:center;font-size:13px;overflow:hidden;
}
.mini img{width:100%;height:100%;object-fit:cover}
.more{font-size:10px;color:var(--faint)}

/* ---------- detail panel ---------- */
.detail{
  background:linear-gradient(160deg,var(--panel2),var(--panel));
  border:1px solid var(--line);border-radius:16px;padding:20px 22px 26px;
  position:sticky;top:74px;max-height:calc(100vh - 92px);overflow-y:auto;
}
.detail .hero-img{
  width:92px;height:92px;border-radius:14px;border:1px solid var(--line2);
  background:var(--bg);display:grid;place-items:center;font-size:46px;overflow:hidden;flex:none;
}
.detail .hero-img img{width:100%;height:100%;object-fit:cover}
.dtop{display:flex;gap:16px;align-items:center}
.dtop h2{font-size:23px;font-weight:800;color:#fff;letter-spacing:.02em}
.dtop .cat{font-size:10.5px;letter-spacing:.22em;color:var(--cyan);font-weight:700;text-transform:uppercase}
.dtop .cls{font-size:11px;color:var(--faint);font-family:Consolas,monospace;word-break:break-all;margin-top:3px}
.dsec{margin-top:18px}
.dsec>h3{
  font-size:11px;letter-spacing:.24em;color:var(--cyan);font-weight:700;
  text-transform:uppercase;border-bottom:1px solid var(--line);
  padding-bottom:6px;margin-bottom:11px;
}
.dsec>h3.alt{color:var(--violet)}
.dsec>h3.con{color:var(--gold)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(105px,1fr));gap:8px}
.tile{
  background:var(--bg);border:1px solid var(--line);border-radius:11px;
  padding:9px;text-align:center;transition:.12s;
}
.tile:hover{border-color:var(--cyan)}
.tile .tic{width:38px;height:38px;margin:0 auto 6px;border-radius:9px;overflow:hidden;
  display:grid;place-items:center;font-size:20px;background:var(--panel2)}
.tile .tic img{width:100%;height:100%;object-fit:cover}
.tile .tn{font-size:11.5px;color:var(--text);font-weight:600;line-height:1.25}
.tile .tv{font-size:11px;color:var(--green);font-weight:700;margin-top:2px}
.tile.con .tv{color:var(--gold)}
.tile.alt .tv{color:var(--violet)}
.cycbox{background:rgba(0,0,0,.25);border:1px solid var(--line);border-radius:12px;
  padding:11px 13px;margin-bottom:9px}
.cycbox .m{font-size:12px;color:var(--dim);margin-bottom:8px}
.cycbox .m b{color:var(--text)}
.note{font-size:11.5px;color:var(--faint);margin-top:6px}
.info{font-size:13.5px}
.info h1,.info h2,.info h3{margin:12px 0 5px;color:var(--cyan2);font-size:13px;
  letter-spacing:.12em;text-transform:uppercase}
.info p{margin:5px 0;color:#b9c9d6}
.info ul{margin:5px 0 5px 19px;color:#b9c9d6}
.info b{color:#fff}
.status{display:inline-block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--cyan2);border:1px solid #2a4a5e;border-radius:999px;padding:3px 10px;margin-bottom:9px}
.method{border:1px solid var(--line);border-radius:9px;padding:11px 13px;margin-bottom:9px;
  background:rgba(255,255,255,.015)}
.mhead{margin-bottom:7px;font-size:13.5px}
.mhead b{color:#fff}
.mtag{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:1px 7px;margin-left:6px}
.mout{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--cyan2);border:1px solid #2a4a5e;border-radius:999px;padding:1px 8px;margin-left:8px}
.pout{font-size:11.5px;color:#b9c9d6;margin:3px 0 0 2px}
.inputs{display:flex;flex-wrap:wrap;gap:6px;margin:7px 0}
.inp{font-size:12px;color:#b9c9d6;border:1px solid var(--line);border-radius:7px;padding:4px 8px}
.inp b{color:#fff}
.inp .role{color:var(--faint);margin-left:6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}
.inp .inote{color:var(--dim);margin-left:6px;font-style:italic}
.phase{margin:8px 0 8px 2px;padding-left:10px;border-left:2px solid #24384a}
.pname{font-size:12px;color:var(--cyan2);letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}
.steps{margin:3px 0 3px 18px;color:#b9c9d6;font-size:13px}
.steps li{margin:2px 0}
.m .lbl{color:var(--faint);text-transform:uppercase;font-size:10.5px;letter-spacing:.08em;margin-right:5px}
.abils{display:flex;flex-wrap:wrap;gap:6px}
.abil{font-size:12px;color:#b9c9d6;border:1px solid var(--line);border-radius:7px;padding:4px 9px}
.abil b{color:#fff}
.abil span{color:var(--dim);margin-left:6px}
.akind{color:var(--faint);text-transform:uppercase;font-size:10.5px;letter-spacing:.08em;margin:8px 0 5px}
.akind:first-child{margin-top:0}
.maps{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.mapchip{font-size:12px;color:#b9c9d6;border:1px solid var(--line);border-radius:999px;padding:3px 10px}
.caution{font-size:12px;font-weight:700;color:var(--gold);border:1px solid var(--gold);
  border-radius:999px;padding:3px 10px;background:rgba(240,180,60,.10)}
.cautionnote{color:var(--gold);font-size:12px;margin-top:7px}
.drops{display:flex;flex-direction:column;gap:4px}
.drop{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#b9c9d6;
  border:1px solid var(--line);border-radius:8px;padding:5px 9px;
  width:100%;text-align:left;transition:.12s}
button.drop:hover{border-color:var(--cyan)}
.drop .dic{width:26px;height:26px;border-radius:6px;overflow:hidden;flex:0 0 auto;
  display:grid;place-items:center;background:rgba(255,255,255,.04);font-size:15px}
.drop .dic img{width:100%;height:100%;object-fit:cover}
.drop b{color:#fff}
.drop .dqty{color:var(--green);font-weight:700}
.drop .dchance{color:var(--violet);font-weight:700}
.drop .drate{color:var(--cyan);font-weight:700}
.drop .dnote{color:var(--dim)}
.efx{border:1px solid var(--line);border-radius:8px;padding:7px 9px;margin-bottom:6px}
.efxh{font-size:12.5px;color:#b9c9d6;margin-bottom:5px}
.efxh b{color:#fff}
.efxh span{color:var(--dim);margin-left:6px}
.efxr{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12.5px;
  color:#b9c9d6;padding:3px 0;border-top:1px solid var(--line)}
.efxr:first-of-type{border-top:0}
.ichip{display:inline-flex;align-items:center;gap:6px}
.ichip b{color:#fff}
.efxr .arrow{color:var(--faint)}
.efxr .pctv{color:var(--gold);font-weight:700}
.efxr .dqty{color:var(--green);font-weight:700}
.efxr .dnote{color:var(--dim)}
.rel{display:grid;grid-template-columns:repeat(auto-fill,minmax(105px,1fr));gap:8px}
.facts{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:2px}
.fact{font-size:12px;color:#b9c9d6;border:1px solid var(--line);border-radius:8px;padding:4px 9px}
.fact .lbl{color:var(--faint);text-transform:uppercase;font-size:10px;
  letter-spacing:.1em;margin-right:6px}
.fact b{color:#fff}
.rarity{border-color:currentColor}
.dtags{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.copy{font-size:11px;color:var(--faint);border:1px solid var(--line);border-radius:7px;
  padding:2px 8px;margin-top:5px}
.copy:hover{color:var(--cyan);border-color:var(--cyan)}
.dempty{color:var(--faint);text-align:center;padding:26px 0}
.pickhint{color:var(--faint);text-align:center;padding:80px 20px}
.err{color:var(--red);text-align:center;padding:70px 0}
.loading{color:var(--faint);text-align:center;padding:70px 0}

@media (max-width:900px){
  .hero{grid-template-columns:1fr}
  .stats{grid-template-columns:repeat(2,1fr)}
  .browse{grid-template-columns:1fr}
  .detail{position:fixed;inset:12px;z-index:60;max-height:none;display:none}
  .detail.open{display:block}
  .dclose{display:inline-grid !important}
}
.dclose{
  display:none;place-items:center;margin-left:auto;width:30px;height:30px;
  border:1px solid var(--line2);border-radius:8px;color:var(--dim);flex:none;
}
</style>
</head>
<body>

<header class="hdr"><div class="wrap hdr-in">
  <div class="brand">
    <span id="logoSlot"><span class="logo-fallback">⬡</span></span>
    <span><div class="t1">DINO DEPOT</div><div class="t2">PRODUCTION ATLAS</div></span>
  </div>
  <nav class="nav">
    <button data-v="overview" class="on">Overview</button>
    <button data-v="creatures">Creature Lookup</button>
    <button data-v="items">Resource Lookup</button>
  </nav>
  <span class="pill">SERVER: <b>${cluster}</b></span>
</div></header>

<main class="wrap">
  <div id="loading" class="loading">Loading production data…</div>
  <div id="error" class="err" style="display:none"></div>

  <!-- OVERVIEW -->
  <section id="v-overview" style="display:none">
    <p class="tag">Your guide to the creatures of ${cluster} — how they're caught, what they drop, and what they make.</p>
    <div class="hero">
      <div class="panel cre">
        <div class="hex">🧬</div>
        <h2>Find by Creature</h2>
        <p>Look up how a creature is tamed, where it spawns, what it drops, and what it produces.</p>
        <div class="searchrow">🔍<input id="ovqc" placeholder="Search creatures…"><button class="go" onclick="ovGo('creatures')">→</button></div>
        <div class="pop"><div class="lbl">POPULAR CREATURES</div><div class="chipset" id="popC"></div></div>
      </div>
      <div class="panel res">
        <div class="hex">💎</div>
        <h2>Find by Resource</h2>
        <p>Look up any resource to see every creature that produces or consumes it.</p>
        <div class="searchrow">🔍<input id="ovqi" placeholder="Search resources…"><button class="go" onclick="ovGo('items')">→</button></div>
        <div class="pop"><div class="lbl">POPULAR RESOURCES</div><div class="chipset" id="popI"></div></div>
      </div>
    </div>
    <div class="stats" id="stats"></div>
    <div class="footnote">
      <span>✅ Data published directly by the server admins</span>
      <span>⚙️ Powered by Dino Depot Studio</span>
      <span>🦖 Not affiliated with Studio Wildcard</span>
    </div>
  </section>

  <!-- CREATURES -->
  <section id="v-creatures" style="display:none">
    <div class="browse">
      <div class="listcol">
        <div class="tools">
          <input id="qc" placeholder="Search creatures, tames, drops…" autocomplete="off">
          <select id="fc"><option value="">All categories</option></select>
          <select id="fm"><option value="">All maps</option></select>
          <select id="fa">
            <option value="">Any status</option>
            <option value="Acquirable">Acquirable</option>
            <option value="Unavailable">Unavailable</option>
          </select>
          <button class="toggle" id="fp" title="Only creatures on the passive production roster">⚙️ Producers</button>
        </div>
        <div class="found" id="foundC"></div>
        <div class="rows" id="rowsC"></div>
      </div>
      <div class="detail" id="dc"><div class="pickhint">Select a creature to see how it's caught, what it drops, and what it produces.</div></div>
    </div>
  </section>

  <!-- ITEMS -->
  <section id="v-items" style="display:none">
    <div class="browse">
      <div class="listcol">
        <div class="tools">
          <input id="qi" placeholder="Search resources…" autocomplete="off">
          <select id="fi"><option value="">All categories</option></select>
        </div>
        <div class="found" id="foundI"></div>
        <div class="rows" id="rowsI"></div>
      </div>
      <div class="detail" id="di"><div class="pickhint">Select a resource to see every creature it comes from.</div></div>
    </div>
  </section>
</main>

<script>
var CFG = {
  dataUrl: ${JSON.stringify(config.dataUrl)},
  imagesUrl: ${JSON.stringify(config.imagesUrl.replace(/\/+$/, ""))}
};
var DATA = null;
var byC = new Map(), byI = new Map();
/* Items again, by normalized path — a drop and a production rule can spell the
   same blueprint differently, and both must reach the one resource page. */
var byIn = new Map();
var selC = null, selI = null;
var prodOnly = false;
var $ = function(id){ return document.getElementById(id); };

function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function imgUrl(rel){
  if(!CFG.imagesUrl || !rel) return null;
  return CFG.imagesUrl + "/" + rel.split("/").map(encodeURIComponent).join("/");
}
function iconBox(e, cls){
  var url = imgUrl(e && e.img);
  if(url){
    return '<span class="'+cls+'"><img src="'+esc(url)+'" alt="" ' +
      'onerror="this.parentNode.textContent=\\''+esc(e.icon||"📦")+'\\'"></span>';
  }
  return '<span class="'+cls+'">'+esc(e && e.icon || "📦")+'</span>';
}
function fmtI(s){
  if(s < 60) return s + "s";
  if(s < 3600){ var m = Math.floor(s/60), r = s%60; return r ? m+"m "+r+"s" : m+"m"; }
  var h = Math.floor(s/3600), mm = Math.round((s%3600)/60);
  return mm ? h+"h "+mm+"m" : h+"h";
}
function fmtN(n){
  if(n >= 100) return String(Math.round(n));
  if(n >= 10) return n.toFixed(1).replace(/\\.0$/,"");
  return n.toFixed(2).replace(/0+$/,"").replace(/\\.$/,"");
}
function pct(v){ return Math.round(v*100) + "%"; }
function normRef(s){ return String(s == null ? "" : s).trim().replace(/_C$/i,"").toLowerCase(); }
/* Resource for a blueprint reference, tolerating case and a trailing _C. */
function lookupItem(ref){ return byI.get(ref) || byIn.get(normRef(ref)) || null; }

/*
 * Whether a creature is on the production roster. The page and the data file
 * publish separately, so data written before "produces" existed still has to
 * read correctly — back then, being listed at all meant being a producer.
 */
function isProducer(c){
  return c.produces === undefined
    ? Boolean(c.cycles && c.cycles.length)
    : Boolean(c.produces);
}

/* Every map a creature is known from — spawns if recorded, else its origin. */
function creatureMaps(c){
  var mp = c.maps || {};
  return (mp.spawns && mp.spawns.length) ? mp.spawns : (mp.origin ? [mp.origin] : []);
}
/* Method tags across a creature's routes, deduped, for the list rows. */
function creatureTags(c){
  var out = [];
  if(!c.acq) return out;
  c.acq.methods.forEach(function(m){
    (m.tags||[]).forEach(function(t){ if(out.indexOf(t) < 0) out.push(t); });
  });
  return out;
}
/*
 * Searchable text for a creature, built once and cached on the record.
 *
 * The list is now a creature lookup rather than a producer list, so searching
 * has to reach what was written about it — a route's name, what it eats, what
 * it drops — not just its own name.
 */
function cHay(c){
  if(c._q) return c._q;
  var parts = [c.name, c.cls, c.category, c.base];
  creatureMaps(c).forEach(function(m){ parts.push(m); });
  if(c.acq){
    parts.push(c.acq.availability);
    c.acq.methods.forEach(function(m){
      parts.push(m.name, m.outcome);
      (m.tags||[]).forEach(function(t){ parts.push(t); });
      (m.inputs||[]).forEach(function(i){ parts.push(i.name); });
    });
  }
  (c.abilities||[]).forEach(function(a){ parts.push(a.label); });
  var d = c.drops || {};
  ["harvest","guaranteed","random","production"].forEach(function(k){
    (d[k]||[]).forEach(function(e){ parts.push(e.name); });
  });
  c._q = parts.join(" ").toLowerCase();
  return c._q;
}

/* Deep link to whatever is open, so a lookup can be pasted to someone. */
function setHash(value){
  if(history.replaceState) history.replaceState(null, "", "#" + value);
  else location.hash = value;
}
function itemKey(id){ return String(id).split(".").pop() || id; }
function copyLink(){
  var url = location.href;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url);
  } else {
    window.prompt("Copy this link", url);
  }
}

/* markdown-lite */
function md(src){
  if(!src) return "";
  var out = "", list = false, para = [];
  function inline(s){
    return s.replace(/\\*\\*([^*]+)\\*\\*/g,"<b>$1</b>").replace(/\\*([^*]+)\\*/g,"<i>$1</i>");
  }
  function flush(){ if(para.length){ out += "<p>"+inline(para.join(" "))+"</p>"; para=[]; } }
  var lines = esc(src).split(/\\r?\\n/);
  for(var i=0;i<lines.length;i++){
    var line = lines[i].trim();
    var h = line.match(/^(#{1,3})\\s+(.*)/);
    if(h){ flush(); if(list){out+="</ul>";list=false;} out += "<h3>"+inline(h[2])+"</h3>"; continue; }
    if(line.indexOf("- ") === 0){ flush(); if(!list){out+="<ul>";list=true;} out += "<li>"+inline(line.slice(2))+"</li>"; continue; }
    if(line === ""){ flush(); if(list){out+="</ul>";list=false;} continue; }
    para.push(line);
  }
  flush(); if(list) out += "</ul>";
  return out;
}

/* per-dino hourly rate for one cycle item */
function ratePerHour(creature, cycle, it){
  var weight = (cycle.mode === "All" || cycle.items.length <= 1) ? 1 : 1/cycle.items.length;
  return it.qty * creature.chance * weight * 3600 / cycle.interval;
}
function creatureTotals(c){
  var totals = new Map();
  c.cycles.forEach(function(cy){
    cy.items.forEach(function(it){
      totals.set(it.ref, (totals.get(it.ref)||0) + ratePerHour(c, cy, it));
    });
  });
  return totals;
}

/* ---------- views ---------- */
function show(view){
  ["overview","creatures","items"].forEach(function(v){
    $("v-"+v).style.display = (v === view && DATA) ? "" : "none";
  });
  document.querySelectorAll(".nav button").forEach(function(b){
    b.classList.toggle("on", b.getAttribute("data-v") === view);
  });
  setHash(view);
}
document.querySelectorAll(".nav button").forEach(function(b){
  b.addEventListener("click", function(){ show(b.getAttribute("data-v")); });
});
function ovGo(view){
  var q = view === "creatures" ? $("ovqc").value : $("ovqi").value;
  show(view);
  var input = view === "creatures" ? $("qc") : $("qi");
  input.value = q; input.dispatchEvent(new Event("input")); input.focus();
}

/* ---------- overview ---------- */
function renderOverview(){
  var producers = 0, documented = 0;
  DATA.creatures.forEach(function(c){
    if(isProducer(c)) producers++;
    if(c.acq || (c.abilities && c.abilities.length) || c.info) documented++;
  });
  $("stats").innerHTML =
    stat("🦖", DATA.creatures.length, "Creatures listed") +
    stat("📖", documented, "With keeper write-ups") +
    stat("⚙️", producers, "Producing creatures") +
    stat("💎", DATA.items.length, "Resources tracked");
  function stat(ic,v,l){
    return '<div class="stat"><span class="ic">'+ic+'</span><span><div class="v">'+v+'</div><div class="l">'+l+'</div></span></div>';
  }
  var topC = DATA.creatures.slice().sort(function(a,b){
    var an=0,bn=0; a.cycles.forEach(function(x){an+=x.items.length}); b.cycles.forEach(function(x){bn+=x.items.length});
    return bn-an;
  }).slice(0,5);
  $("popC").innerHTML = topC.map(function(c){
    return '<button class="tagchip" onclick="openC(\\''+jsq(c.id)+'\\')">'+esc(c.name)+'</button>';
  }).join("");
  var topI = DATA.items.slice().sort(function(a,b){
    return (b.producedBy.length+b.alternateFrom.length) - (a.producedBy.length+a.alternateFrom.length);
  }).slice(0,5);
  $("popI").innerHTML = topI.map(function(it){
    return '<button class="tagchip" onclick="openI(\\''+jsq(it.id)+'\\')">'+esc(it.name)+'</button>';
  }).join("");
}
function jsq(s){ return String(s).replace(/\\\\/g,"\\\\\\\\").replace(/'/g,"\\\\'"); }

/* ---------- creature list + detail ---------- */
function fillCats(sel, list){
  var cats = {};
  list.forEach(function(e){ if(e.category) cats[e.category] = 1; });
  Object.keys(cats).sort().forEach(function(c){
    var o = document.createElement("option"); o.value = c; o.textContent = c; sel.appendChild(o);
  });
}
/** Every map any listed creature is known from. */
function fillMaps(sel, list){
  var maps = {};
  list.forEach(function(c){ creatureMaps(c).forEach(function(m){ maps[m] = 1; }); });
  Object.keys(maps).sort().forEach(function(m){
    var o = document.createElement("option"); o.value = m; o.textContent = m; sel.appendChild(o);
  });
}

/**
 * Opens whatever the URL asks for. "#creature=Rex" and "#item=PrimalItem…"
 * make a lookup shareable — the reason someone sends this page to someone
 * else is almost always one specific creature.
 */
function openInitial(hash){
  var parts = String(hash || "").split("=");
  var key = decodeURIComponent(parts.slice(1).join("=") || "");
  if(parts[0] === "creature" && key){
    var c = DATA.creatures.filter(function(x){
      return String(x.cls).toLowerCase() === key.toLowerCase() ||
        x.name.toLowerCase() === key.toLowerCase();
    })[0];
    if(c){ openC(c.id); return; }
    show("creatures");
    return;
  }
  if(parts[0] === "item" && key){
    var i = DATA.items.filter(function(x){
      return itemKey(x.id).toLowerCase() === key.toLowerCase() ||
        x.name.toLowerCase() === key.toLowerCase();
    })[0];
    if(i){ openI(i.id); return; }
    show("items");
    return;
  }
  show(["overview","creatures","items"].indexOf(parts[0]) >= 0 ? parts[0] : "overview");
}

function renderCList(){
  var q = $("qc").value.trim().toLowerCase();
  var cat = $("fc").value, map = $("fm").value, av = $("fa").value;
  var list = DATA.creatures.filter(function(c){
    if(cat && c.category !== cat) return false;
    if(map && creatureMaps(c).indexOf(map) < 0) return false;
    if(av && (!c.acq || c.acq.availability !== av)) return false;
    if(prodOnly && !isProducer(c)) return false;
    return !q || cHay(c).indexOf(q) >= 0;
  });
  $("foundC").textContent = list.length + " CREATURES";
  $("rowsC").innerHTML = list.map(function(c){
    /* Producers show what they make; everything else shows how it is caught,
       which is the only reason it is on the page at all. */
    var right;
    if(isProducer(c)){
      var seen = {}, chips = [];
      c.cycles.forEach(function(cy){ cy.items.forEach(function(it){
        if(!seen[it.ref]){ seen[it.ref] = 1; var t = lookupItem(it.ref); if(t) chips.push(t); }
      })});
      right = chips.slice(0,5).map(function(t){ return iconBox(t,"mini"); }).join("") +
        (chips.length > 5 ? '<span class="more">+'+(chips.length-5)+'</span>' : '');
    } else {
      var tags = creatureTags(c);
      if(!tags.length && c.acq && c.acq.availability) tags = [c.acq.availability];
      right = tags.slice(0,2).map(function(t){
        return '<span class="mtag">'+esc(t)+'</span>';
      }).join("");
    }
    var sub = [c.category || "", isProducer(c) ? "Producer" : ""].filter(Boolean).join(" · ");
    return '<button class="row'+(selC===c.id?" on":"")+'" onclick="openC(\\''+jsq(c.id)+'\\')">' +
      iconBox(c,"avatar") +
      '<span class="mid"><div class="nm">'+esc(c.name)+'</div><div class="ct">'+esc(sub)+'</div></span>' +
      '<span class="prod">'+right+'</span></button>';
  }).join("") || '<div class="dempty">No matches.</div>';
}
function openC(id){
  selC = id; show("creatures"); renderCList();
  var c = byC.get(id);
  if(!c){ return; }
  var totals = creatureTotals(c);
  var tiles = [];
  totals.forEach(function(rate, ref){
    var t = lookupItem(ref); if(!t) return;
    tiles.push('<button class="tile" onclick="openI(\\''+jsq(ref)+'\\')">'+iconBox(t,"tic")+
      '<div class="tn">'+esc(t.name)+'</div><div class="tv">≈ '+fmtN(rate)+' / hr</div></button>');
  });
  var body = '<div class="dtop">'+iconBox(c,"hero-img")+'<span>' +
    '<div class="cat">'+esc(c.category||"")+'</div><h2>'+esc(c.name)+'</h2>' +
    '<div class="cls">'+esc(c.cls)+'</div>' +
    '<button class="copy" onclick="copyLink()">🔗 Copy link</button></span>' +
    '<button class="dclose" onclick="closeDetail()">✕</button></div>';
  /* Only a creature on the production roster gets a Produces block — for the
     rest, an empty one would read as "makes nothing", which is a claim about
     the mod rather than about this cluster's configuration. */
  if(isProducer(c)){
    body += '<div class="dsec"><h3>Produces'+(c.chance<1?' · '+pct(c.chance)+' chance per attempt':'')+'</h3>' +
      (tiles.length ? '<div class="tiles">'+tiles.join("")+'</div>' : '<div class="dempty">No outputs configured.</div>') +
      '<div class="note">Estimated per producing dino, before cycle/terminal caps.</div></div>';
  }

  c.cycles.forEach(function(cy, i){
    var inner = "";
    cy.items.forEach(function(it){
      var t = lookupItem(it.ref);
      inner += '<button class="tile" onclick="openI(\\''+jsq(it.ref)+'\\')">'+iconBox(t||{},"tic")+
        '<div class="tn">'+esc(t?t.name:"?")+'</div><div class="tv">×'+it.qty+' / cycle</div></button>';
      it.alternates.forEach(function(a){
        var at = lookupItem(a.ref);
        inner += '<button class="tile alt" onclick="openI(\\''+jsq(a.ref)+'\\')">'+iconBox(at||{},"tic")+
          '<div class="tn">🎲 '+esc(at?at.name:"?")+'</div><div class="tv">×'+a.qty+' · '+pct(it.altChance)+'</div></button>';
      });
      it.consumes.forEach(function(cn){
        var ct = lookupItem(cn.ref);
        inner += '<button class="tile con" onclick="openI(\\''+jsq(cn.ref)+'\\')">'+iconBox(ct||{},"tic")+
          '<div class="tn">🔻 '+esc(ct?ct.name:"?")+'</div><div class="tv">−'+cn.qty+(it.consumeChance<1?' · '+pct(it.consumeChance):'')+'</div></button>';
      });
    });
    body += '<div class="dsec"><h3>Cycle '+(i+1)+(cy.name?' — '+esc(cy.name):'')+'</h3>' +
      '<div class="cycbox"><div class="m">Runs every <b>'+fmtI(cy.interval)+'</b>' +
      (cy.items.length>1 ? ' · <b>'+esc(cy.mode)+'</b> of '+cy.items.length+' outputs' : '') + '</div>' +
      '<div class="tiles">'+inner+'</div></div></div>';
  });

  body += acquisitionBlock(c);

  // Where to find it. Spawn maps are what a player wants; the map of origin is
  // the fallback when nobody has recorded spawns yet.
  var mp = c.maps || {};
  var mapList = (mp.spawns && mp.spawns.length) ? mp.spawns : (mp.origin ? [mp.origin] : []);
  if(mapList.length || mp.caution){
    body += '<div class="dsec"><h3>Found on</h3><div class="maps">' +
      mapList.map(function(m){ return '<span class="mapchip">'+esc(m)+'</span>'; }).join('') +
      (mp.caution ? '<span class="caution">⚠ Caution</span>' : '') +
      '</div>' +
      (mp.caution
        ? '<div class="cautionnote">This cluster does not run '+
          (mapList.length>1?'any of these maps':'this map')+
          ' — it may still be obtainable elsewhere, so check before counting on it.</div>'
        : '') +
      ((!mp.spawns || !mp.spawns.length) && mp.origin
        ? '<div class="note">Map of origin — specific spawn maps have not been recorded.</div>'
        : '') +
      '</div>';
  }

  if(c.abilities && c.abilities.length){
    // Grouped, because "what can it do" and "what is it" are different questions.
    var kinds = [['active','Active'],['passive','Passive']];
    var abilBody = '';
    kinds.forEach(function(k){
      var listed = c.abilities.filter(function(a){
        // Data written before the split carries no kind; it read as passive.
        return (a.kind || 'passive') === k[0];
      });
      if(!listed.length) return;
      abilBody += '<div class="akind">'+k[1]+'</div>';
      // Plain traits read as chips; a structured effect is a per-item table
      // and has to keep its rows, or "reduces weight" says nothing useful.
      var plain = listed.filter(function(a){ return !a.effect || a.effect === 'none'; });
      var tables = listed.filter(function(a){ return a.effect && a.effect !== 'none'; });
      if(plain.length){
        abilBody += '<div class="abils">' + plain.map(function(a){
          return '<div class="abil"><b>'+esc(a.label)+'</b>' +
            (a.detail ? ' <span>'+esc(a.detail)+'</span>' : '') + '</div>';
        }).join('') + '</div>';
      }
      tables.forEach(function(a){
        abilBody += '<div class="efx"><div class="efxh"><b>'+esc(a.label)+'</b>' +
          (a.detail ? ' <span>'+esc(a.detail)+'</span>' : '') + '</div>';
        abilBody += (a.rows||[]).map(function(r){
          var out = '<div class="efxr">'+itemChip(r.item);
          if(r.rate) out += '<span class="dqty">×'+esc(r.rate)+'</span>';
          if(r.to){
            out += '<span class="arrow">→</span>'+itemChip(r.to);
            if(r.toRate) out += '<span class="dqty">×'+esc(r.toRate)+'</span>';
          }
          if(r.percent) out += '<span class="pctv">'+esc(r.percent)+'</span>';
          if(r.note) out += '<span class="dnote">'+esc(r.note)+'</span>';
          return out + '</div>';
        }).join('');
        abilBody += '</div>';
      });
    });
    body += '<div class="dsec"><h3>Abilities</h3>'+abilBody+'</div>';
  }

  body += dropsBlock(c);

  if(c.dragWeight !== null && c.dragWeight !== undefined){
    body += '<div class="dsec"><h3>Technical</h3><div class="m">Drag weight <b>' +
      esc(String(c.dragWeight)) + '</b></div></div>';
  }

  if(c.info) body += '<div class="dsec"><h3>Keeper Notes</h3><div class="info">'+md(c.info)+'</div></div>';

  /**
   * Harvest and loot as three labelled lists. Kept separate rather than merged
   * into one table because "always drops" and "might drop" are answers to
   * different questions, and running them together reads as a promise.
   */
  /** Icon + name for an item inside an effect row. */
  function itemChip(it){
    if(!it) return '';
    return '<span class="ichip">'+iconBox(it,"dic")+'<b>'+esc(it.name)+'</b></span>';
  }

  function dropsBlock(c){
    var d = c.drops;
    if(!d) return '';
    var lists = [
      ['harvest','Harvest'],
      ['guaranteed','Guaranteed loot'],
      ['random','Random loot'],
      ['production','Production (tamed inventory)']
    ];
    var out = '';
    lists.forEach(function(l){
      var entries = d[l[0]];
      if(!entries || !entries.length) return;
      out += '<div class="akind">'+l[1]+'</div><div class="drops">' +
        entries.map(function(e){
          // A drop that is also a tracked resource links through to it — that
          // is the whole point of publishing both sides.
          var known = e.ref ? lookupItem(e.ref) : null;
          var inner = iconBox(e,"dic")+'<b>'+esc(e.name)+'</b>' +
            (e.qty ? '<span class="dqty">×'+esc(e.qty)+'</span>' : '') +
            (e.rate ? '<span class="drate">'+esc(e.rate)+'</span>' : '') +
            (e.chance ? '<span class="dchance">'+esc(e.chance)+'</span>' : '') +
            (e.note ? '<span class="dnote">'+esc(e.note)+'</span>' : '');
          return known
            ? '<button class="drop" onclick="openI(\\''+jsq(known.id)+'\\')">'+inner+'</button>'
            : '<div class="drop">'+inner+'</div>';
        }).join('') + '</div>';
    });
    return out ? '<div class="dsec"><h3>Drops</h3>'+out+'</div>' : '';
  }

  function acquisitionBlock(c){
    var a = c.acq;
    if(!a) return '';
    var out = '<div class="dsec"><h3>Acquisition</h3>';
    if(a.availability) out += '<div class="status">'+esc(a.availability)+'</div>';
    if(a.inheritedFrom){
      out += '<div class="note">Same process as '+esc(a.inheritedFrom)+'.</div>';
    }
    a.methods.forEach(function(m){
      out += '<div class="method"><div class="mhead"><b>'+esc(m.name)+'</b>';
      if(m.outcome) out += '<span class="mout">'+esc(m.outcome)+'</span>';
      m.tags.forEach(function(t){ out += '<span class="mtag">'+esc(t)+'</span>'; });
      out += '</div>';
      if(m.requirements) out += '<div class="m">Needs: <b>'+esc(m.requirements)+'</b></div>';
      if(m.inputs.length){
        out += '<div class="inputs">' + m.inputs.map(function(i){
          return '<div class="inp"><b>'+esc(i.name)+'</b>' +
            '<span class="role">'+esc(i.role)+'</span>' +
            (i.note ? '<span class="inote">'+esc(i.note)+'</span>' : '') + '</div>';
        }).join('') + '</div>';
      }
      m.phases.forEach(function(p, pi){
        out += '<div class="phase"><div class="pname">'+(pi+1)+'. '+esc(p.name)+'</div>';
        if(p.steps.length){
          out += '<ol class="steps">' + p.steps.map(function(s){
            return '<li>'+esc(s)+'</li>';
          }).join('') + '</ol>';
        }
        if(p.note) out += '<div class="note">'+esc(p.note)+'</div>';
        // Phase-level loop/reset conditions, shown only when populated.
        [['Repeat until', p.repeatUntil], ['Completed when', p.completedWhen],
         ['Failure / reset', p.failureOrReset], ['Then', p.transitionNote]
        ].forEach(function(pair){
          if(pair[1]) out += '<div class="pout"><span class="lbl">'+pair[0]+'</span> '+esc(pair[1])+'</div>';
        });
        out += '</div>';
      });
      [['Repeat until', m.repeatUntil], ['Completion', m.completion],
       ['Failure / reset', m.failure], ['Effectiveness', m.effectiveness]
      ].forEach(function(pair){
        if(pair[1]) out += '<div class="m"><span class="lbl">'+pair[0]+'</span> '+esc(pair[1])+'</div>';
      });
      if(m.strategy) out += '<div class="info">'+md(m.strategy)+'</div>';
      out += '</div>';
    });
    return out + '</div>';
  }

  var related = DATA.creatures.filter(function(o){
    return o.id !== c.id && o.base === c.base;
  });
  if(related.length){
    body += '<div class="dsec"><h3>Related Variants</h3><div class="rel">' +
      related.map(function(o){
        return '<button class="tile" onclick="openC(\\''+jsq(o.id)+'\\')">'+iconBox(o,"tic")+
          '<div class="tn">'+esc(o.name)+'</div></button>';
      }).join("") + '</div></div>';
  }
  $("dc").innerHTML = body;
  $("dc").classList.add("open");
  $("dc").scrollTop = 0;
  setHash("creature=" + encodeURIComponent(c.cls || c.name));
}

/* ---------- item list + detail ---------- */
function renderIList(){
  var q = $("qi").value.toLowerCase(), cat = $("fi").value;
  var list = DATA.items.filter(function(it){
    if(cat && it.category !== cat) return false;
    if(!q) return true;
    return [it.name, it.type, it.rarity].join(" ").toLowerCase().indexOf(q) >= 0;
  });
  $("foundI").textContent = list.length + " RESOURCES";
  $("rowsI").innerHTML = list.map(function(it){
    var producers = it.producedBy.slice(0,5).map(function(r){
      var c = byC.get(r); return c ? iconBox(c,"mini") : "";
    }).join("");
    return '<button class="row'+(selI===it.id?" on":"")+'" onclick="openI(\\''+jsq(it.id)+'\\')">' +
      iconBox(it,"avatar") +
      '<span class="mid"><div class="nm">'+esc(it.name)+'</div><div class="ct">'+esc(it.category||"")+'</div></span>' +
      '<span class="prod">'+producers+
      (it.producedBy.length>5?'<span class="more">+'+(it.producedBy.length-5)+'</span>':'')+'</span></button>';
  }).join("") || '<div class="dempty">No matches.</div>';
}
function openI(id){
  var it = lookupItem(id);
  if(!it) return;
  selI = it.id; show("items"); renderIList();
  var body = '<div class="dtop">'+iconBox(it,"hero-img")+'<span>' +
    '<div class="cat">'+esc(it.category||"")+'</div><h2>'+esc(it.name)+'</h2>' +
    '<div class="cls">'+esc(it.id)+'</div>' +
    '<button class="copy" onclick="copyLink()">🔗 Copy link</button></span>' +
    '<button class="dclose" onclick="closeDetail()">✕</button></div>';

  // The handful of facts an admin recorded about the item itself.
  var facts = [];
  if(it.type) facts.push(fact("Type", it.type));
  if(it.rarity) facts.push('<span class="fact"><span class="lbl">Rarity</span><b>'+esc(it.rarity)+'</b></span>');
  if(it.stack !== null && it.stack !== undefined) facts.push(fact("Stack", it.stack));
  if(facts.length) body += '<div class="dsec"><div class="facts">'+facts.join("")+'</div></div>';
  function fact(label, value){
    return '<span class="fact"><span class="lbl">'+esc(label)+'</span><b>'+esc(String(value))+'</b></span>';
  }

  function creatureTiles(refs, cls, label, withRate){
    if(!refs || !refs.length) return "";
    var tiles = refs.map(function(r){
      var c = byC.get(r); if(!c) return "";
      var rate = 0;
      if(withRate){
        c.cycles.forEach(function(cy){ cy.items.forEach(function(x){
          if(normRef(x.ref) === normRef(it.id)) rate += ratePerHour(c, cy, x);
          x.alternates.forEach(function(a){ if(normRef(a.ref) === normRef(it.id)) rate += ratePerHour(c, cy, {qty:a.qty}) * x.altChance / Math.max(1,x.alternates.length); });
        })});
      }
      return '<button class="tile '+cls+'" onclick="openC(\\''+jsq(r)+'\\')">'+iconBox(c,"tic")+
        '<div class="tn">'+esc(c.name)+'</div>' +
        (rate>0?'<div class="tv">≈ '+fmtN(rate)+' / hr</div>':'')+'</button>';
    }).join("");
    return '<div class="dsec"><h3 class="'+cls+'">'+label+'</h3><div class="tiles">'+tiles+'</div></div>';
  }

  body += creatureTiles(it.producedBy, "", "Produced by", true);
  body += creatureTiles(it.alternateFrom, "alt", "🎲 Alternate drop from", true);
  body += creatureTiles(it.consumedBy, "con", "🔻 Consumed by", true);

  /*
   * The other half of "where do I get this": what the creature itself yields,
   * as recorded on its own page. Kept apart from the passive-production
   * relationships above, which are this cluster's configuration rather than
   * something true of the creature.
   */
  var from = it.from || {};
  body += creatureTiles(from.harvest, "", "🔪 Harvested from", false);
  body += creatureTiles(from.guaranteed, "", "🎁 Always dropped by", false);
  body += creatureTiles(from.random, "alt", "🎲 Sometimes dropped by", false);
  body += creatureTiles(from.production, "", "⏳ Made in the inventory of", false);

  var anyFrom = ["harvest","guaranteed","random","production"].some(function(k){
    return (from[k] || []).length > 0;
  });
  if(!it.producedBy.length && !it.alternateFrom.length && !it.consumedBy.length && !anyFrom){
    body += '<div class="dempty">Not referenced by any production rule.</div>';
  }
  if(it.info) body += '<div class="dsec"><h3>Notes</h3><div class="info">'+md(it.info)+'</div></div>';
  $("di").innerHTML = body;
  $("di").classList.add("open");
  $("di").scrollTop = 0;
  setHash("item=" + encodeURIComponent(itemKey(it.id)));
}
function closeDetail(){
  $("dc").classList.remove("open");
  $("di").classList.remove("open");
  var on = document.querySelector(".nav button.on");
  if(on) setHash(on.getAttribute("data-v"));
}

/* ---------- boot ---------- */
["qc","fc","fm","fa"].forEach(function(id){ $(id).addEventListener("input", renderCList); });
["qi","fi"].forEach(function(id){ $(id).addEventListener("input", renderIList); });
$("fp").addEventListener("click", function(){
  prodOnly = !prodOnly;
  $("fp").classList.toggle("on", prodOnly);
  renderCList();
});
["ovqc","ovqi"].forEach(function(id, i){
  $(id).addEventListener("keydown", function(ev){
    if(ev.key === "Enter") ovGo(i === 0 ? "creatures" : "items");
  });
});

fetch(CFG.dataUrl, { cache: "no-cache" })
  .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
  .then(function(data){
    DATA = data;
    data.creatures.forEach(function(c){ byC.set(c.id, c); });
    data.items.forEach(function(i){ byI.set(i.id, i); byIn.set(normRef(i.id), i); });
    var logoUrl = imgUrl(data.logo);
    if(logoUrl){
      $("logoSlot").innerHTML = '<img class="logo" src="'+esc(logoUrl)+'" alt="" ' +
        'onerror="this.outerHTML=\\'<span class=&quot;logo-fallback&quot;>⬡</span>\\'">';
    }
    $("loading").style.display = "none";
    renderOverview();
    fillCats($("fc"), data.creatures);
    fillCats($("fi"), data.items);
    fillMaps($("fm"), data.creatures);
    renderCList();
    renderIList();
    openInitial((location.hash || "#overview").slice(1));
  })
  .catch(function(err){
    $("loading").style.display = "none";
    var e = $("error");
    e.style.display = "";
    e.textContent = "Could not load production data ("+err.message+"). Try refreshing.";
  });
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
