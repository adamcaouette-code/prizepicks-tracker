import { useState, useEffect, useCallback, useMemo } from 'react';

// ─── PrizePicks ───────────────────────────────────────────────────────────────
async function fetchPP() {
  const res = await fetch('/api/prizepicks');
  if (!res.ok) throw new Error(`PrizePicks error ${res.status}`);
  return res.json();
}
function parseDiff(a) {
  const t = (a.odds_type||a.projection_type||a.type_name||'').toLowerCase();
  if (t.includes('less')||t.includes('goblin')) return 'goblin';
  if (t.includes('more')||t.includes('demon'))  return 'demon';
  if (t.includes('standard')) return 'standard';
  return 'unknown';
}
function parsePP(raw) {
  const { data=[], included=[] } = raw;
  const players={}, leagues={}, games={};
  for (const x of included) {
    if (x.type==='new_player') players[x.id]=x.attributes;
    if (x.type==='league')     leagues[x.id]=x.attributes;
    if (x.type==='game'||x.type==='match') games[x.id]=x.attributes;
  }
  const rawDebug = data[0]?.attributes||null;
  const props = data.filter(d=>d.type==='projection').map(proj=>{
    const a=proj.attributes||{}, player=players[proj.relationships?.new_player?.data?.id]||{};
    const lid=proj.relationships?.league?.data?.id;
    const gid=proj.relationships?.game?.data?.id||proj.relationships?.match?.data?.id||null;
    const ga=games[gid]||{}, league=leagues[lid]||{};
    return { id:proj.id, player:player.name||a.description||'Unknown', team:player.team||'', position:player.position||'', statType:a.stat_type||'', line:a.line_score??null, leagueName:league.name||'', leagueId:lid||'', gameId:gid||('t_'+(player.team||'x')), gameLabel:ga.away_team&&ga.home_team?`${ga.away_team} @ ${ga.home_team}`:(player.team||''), startTime:a.start_time||ga.start_time||'', status:a.status||ga.status||'pre_game', isPromo:a.is_promo||false, diff:parseDiff(a) };
  });
  return { props, rawDebug };
}
function groupProps(props) {
  const out={};
  for (const p of props) {
    if (!out[p.leagueId]) out[p.leagueId]={name:p.leagueName,id:p.leagueId,games:{}};
    const lg=out[p.leagueId];
    if (!lg.games[p.gameId]) lg.games[p.gameId]={label:p.gameLabel,startTime:p.startTime,status:p.status,props:[]};
    lg.games[p.gameId].props.push(p);
  }
  return out;
}

// ─── ESPN ─────────────────────────────────────────────────────────────────────
const ESPN_MAP = {
  nba:{sport:'basketball',league:'nba'}, mlb:{sport:'baseball',league:'mlb'},
  nhl:{sport:'hockey',league:'nhl'},     nfl:{sport:'football',league:'nfl'},
  wnba:{sport:'basketball',league:'wnba'},
};
function leagueToEspn(name) {
  const n=name.toLowerCase().trim();
  for (const [k,v] of Object.entries(ESPN_MAP)) if (n===k||n.includes(k)) return v;
  return null;
}

// Season avg stat keys
const STAT_KEYS = {
  'Points':{k:['avgPoints'],f:v=>v[0]}, 'Rebounds':{k:['avgRebounds'],f:v=>v[0]}, 'Assists':{k:['avgAssists'],f:v=>v[0]},
  'Steals':{k:['avgSteals'],f:v=>v[0]}, 'Blocks':{k:['avgBlocks'],f:v=>v[0]}, 'Blocked Shots':{k:['avgBlocks'],f:v=>v[0]},
  'Turnovers':{k:['avgTurnovers'],f:v=>v[0]}, '3-PT Made':{k:['avg3PointFieldGoalsMade'],f:v=>v[0]},
  '3-Pointers Made':{k:['avg3PointFieldGoalsMade'],f:v=>v[0]},
  '2-PT Made':{k:['avgFieldGoalsMade','avg3PointFieldGoalsMade'],f:v=>v[0]-v[1]},
  'Free Throws Made':{k:['avgFreeThrowsMade'],f:v=>v[0]},
  'PRA':{k:['avgPoints','avgRebounds','avgAssists'],f:v=>v[0]+v[1]+v[2]},
  'Pts+Reb':{k:['avgPoints','avgRebounds'],f:v=>v[0]+v[1]}, 'Pts+Ast':{k:['avgPoints','avgAssists'],f:v=>v[0]+v[1]},
  'Reb+Ast':{k:['avgRebounds','avgAssists'],f:v=>v[0]+v[1]}, 'Blk+Stl':{k:['avgBlocks','avgSteals'],f:v=>v[0]+v[1]},
  'Hits':{k:['avgHits'],f:v=>v[0]}, 'Home Runs':{k:['avgHomeRuns'],f:v=>v[0]}, 'Total Bases':{k:['avgTotalBases'],f:v=>v[0]},
  'RBIs':{k:['avgRBI'],f:v=>v[0]}, 'Strikeouts':{k:['avgStrikeouts'],f:v=>v[0]},
  'Goals':{k:['avgGoals'],f:v=>v[0]}, 'Shots on Goal':{k:['avgShots'],f:v=>v[0]},
  'Passing Yards':{k:['avgPassingYards'],f:v=>v[0]}, 'Rushing Yards':{k:['avgRushingYards'],f:v=>v[0]},
  'Receiving Yards':{k:['avgReceivingYards'],f:v=>v[0]}, 'Receptions':{k:['avgReceptions'],f:v=>v[0]},
};
function computeAvg(statType, flat) {
  const m=STAT_KEYS[statType]; if (!m) return null;
  const vals=m.k.map(k=>flat[k]); if (vals.some(v=>v==null||isNaN(v))) return null;
  const r=m.f(vals); return isNaN(r)?null:Math.round(r*10)/10;
}

// Game log per-game stat functions
const GAMELOG_FN = {
  'Points':g=>g.pts, 'Rebounds':g=>g.reb, 'Assists':g=>g.ast,
  'Steals':g=>g.stl, 'Blocks':g=>g.blk, 'Blocked Shots':g=>g.blk, 'Turnovers':g=>g.to,
  '3-PT Made':g=>g.threepm, '3-Pointers Made':g=>g.threepm,
  '2-PT Made':g=>(g.fgm!=null&&g.threepm!=null)?g.fgm-g.threepm:null,
  'Free Throws Made':g=>g.ftm,
  'PRA':g=>(g.pts!=null&&g.reb!=null&&g.ast!=null)?g.pts+g.reb+g.ast:null,
  'Pts+Reb':g=>(g.pts!=null&&g.reb!=null)?g.pts+g.reb:null,
  'Pts+Ast':g=>(g.pts!=null&&g.ast!=null)?g.pts+g.ast:null,
  'Reb+Ast':g=>(g.reb!=null&&g.ast!=null)?g.reb+g.ast:null,
  'Blk+Stl':g=>(g.blk!=null&&g.stl!=null)?g.blk+g.stl:null,
  'Hits':g=>g.h, 'Home Runs':g=>g.hr, 'Strikeouts':g=>g.k, 'Total Bases':g=>g.tb,
  'Goals':g=>g.g, 'Shots on Goal':g=>g.sog,
};

function parseGameLogStat(raw) {
  if (raw==null) return null;
  const s=String(raw);
  if (s.includes('-') && !s.startsWith('-')) return parseFloat(s.split('-')[0]);
  return parseFloat(s);
}

function parseGameLog(data) {
  const regSeason = data.seasonTypes?.find(st=>st.id===2) || data.seasonTypes?.slice(-1)[0];
  if (!regSeason) return [];
  const cat = regSeason.categories?.find(c=>c.name==='general') || regSeason.categories?.[0];
  if (!cat) return [];
  // build label→index map
  const idx={};
  (cat.labels||[]).forEach((lbl,i)=>{
    const key=lbl.toUpperCase().replace(/[^A-Z0-9]/g,'');
    idx[key]=i;
    idx[lbl.toUpperCase()]=i;
    if (lbl.includes('-')) idx[lbl.split('-')[0].toUpperCase()]=i;
  });
  const get=(stats,key)=>{ const i=idx[key]; return i!=null?parseGameLogStat(stats[i]):null; };
  const eventOrder=(regSeason.events||[]).map(e=>e.id);
  const eventMap=cat.events||{};
  return eventOrder.map(id=>{
    const stats=eventMap[id]?.stats||[];
    return {
      pts:get(stats,'PTS'), reb:get(stats,'REB'), ast:get(stats,'AST'),
      stl:get(stats,'STL'), blk:get(stats,'BLK'), to:get(stats,'TO'),
      threepm:get(stats,'3PM')??get(stats,'3M')??get(stats,'TPM'),
      fgm:get(stats,'FGM'), ftm:get(stats,'FTM'),
      h:get(stats,'H'), hr:get(stats,'HR'), k:get(stats,'K')??get(stats,'SO'), tb:get(stats,'TB'),
      g:get(stats,'G'), sog:get(stats,'S')??get(stats,'SOG'),
    };
  }).filter(g=>Object.values(g).some(v=>v!=null&&!isNaN(v)));
}

function computeRecentAvg(statType, games, n) {
  const fn=GAMELOG_FN[statType]; if (!fn||!games?.length) return null;
  const recent=games.slice(-n);
  const vals=recent.map(fn).filter(v=>v!=null&&!isNaN(v));
  if (!vals.length) return null;
  return Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*10)/10;
}

// Injury status
function parseInjuryStatus(detailData) {
  const ath=detailData?.athlete||detailData;
  if (!ath) return null;
  const injuries=ath.injuries||[];
  const latest=injuries[0];
  const statusName=(ath.status?.type?.description||ath.status?.name||ath.status||'').toLowerCase();
  return {
    statusType: statusName,
    injuryStatus: latest?.status||null,
    injuryDesc: latest?.type?.description||latest?.shortComment||null,
  };
}

async function espnApiFetch(url) {
  for (const u of [url, 'https://corsproxy.io/?'+encodeURIComponent(url)]) {
    try { const r=await fetch(u,{headers:{Accept:'application/json'}}); if(r.ok)return r.json(); } catch(_) {}
  }
  return null;
}

async function loadPlayerStats(names, cfg, onProgress) {
  const results={}, BATCH=3; let done=0;
  for (let i=0; i<names.length; i+=BATCH) {
    const batch=names.slice(i,i+BATCH);
    await Promise.all(batch.map(async name=>{
      try {
        // Step 1: search → get ID
        const searchData = await espnApiFetch(
          `https://site.api.espn.com/apis/common/v3/sports/${cfg.sport}/${cfg.league}/athletes?searchTerm=${encodeURIComponent(name)}&limit=5&active=true`
        );
        const exact=searchData?.items?.find(x=>x.displayName?.toLowerCase()===name.toLowerCase());
        const id=(exact||searchData?.items?.[0])?.id;
        if (!id) { results[name]={stats:{},games:[],injury:null}; done++; onProgress(done,names.length); return; }
        // Step 2: fetch stats, gamelog, detail in parallel
        const [statsData, gamelogData, detailData] = await Promise.all([
          espnApiFetch(`https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/athletes/${id}/statistics`),
          espnApiFetch(`https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/athletes/${id}/gamelog`),
          espnApiFetch(`https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/athletes/${id}`),
        ]);
        // Parse stats
        const flat={};
        for (const cat of statsData?.splits?.categories||[])
          for (const s of cat.stats||[])
            if (s.name&&s.value!=null) flat[s.name]=parseFloat(s.value);
        results[name] = {
          stats: flat,
          games: gamelogData ? parseGameLog(gamelogData) : [],
          injury: parseInjuryStatus(detailData),
        };
      } catch(_) { results[name]={stats:{},games:[],injury:null}; }
      done++; onProgress(done,names.length);
    }));
    if (i+BATCH<names.length) await new Promise(r=>setTimeout(r,600));
  }
  return results;
}

// ─── Book comparison ──────────────────────────────────────────────────────────
const SPORT_TO_ODDSAPI = {nba:'basketball_nba',mlb:'baseball_mlb',nhl:'icehockey_nhl',nfl:'americanfootball_nfl',wnba:'basketball_wnba'};
const PP_TO_MARKET = {
  'Points':'player_points','Rebounds':'player_rebounds','Assists':'player_assists',
  '3-PT Made':'player_threes','3-Pointers Made':'player_threes','Steals':'player_steals',
  'Blocks':'player_blocks','Blocked Shots':'player_blocks','Turnovers':'player_turnovers',
  'Hits':'player_hits','Home Runs':'player_home_runs','Total Bases':'player_total_bases',
  'Strikeouts':'player_strikeouts','Passing Yards':'player_pass_yds','Rushing Yards':'player_rush_yds',
  'Receiving Yards':'player_reception_yds','Receptions':'player_receptions',
  'Goals':'player_goals','Shots on Goal':'player_shots_on_goal',
};
function lookupBookLine(ppName, market, bookLines) {
  if (!bookLines) return null;
  const key=ppName.toLowerCase();
  if (bookLines[key]?.[market]) return {data:bookLines[key][market],matched:'exact',dkName:ppName};
  const last=key.split(' ').pop();
  const fk=Object.keys(bookLines).find(k=>k.split(' ').pop()===last);
  if (fk&&bookLines[fk]?.[market]) return {data:bookLines[fk][market],matched:'fuzzy',dkName:fk};
  return null;
}
async function fetchDKLines(leagueName, props, onProgress) {
  const sportKey=SPORT_TO_ODDSAPI[leagueName.toLowerCase()];
  if (!sportKey) return {bookLines:{},remaining:null};
  const markets=[...new Set(props.map(p=>PP_TO_MARKET[p.statType]).filter(Boolean))];
  if (!markets.length) return {bookLines:{},remaining:null};
  onProgress('Fetching events...');
  const evJson=await fetch(`/api/dk-lines?sport=${sportKey}`).then(r=>r.json());
  if (evJson.error) throw new Error(evJson.error);
  const events=evJson.data||[]; let remaining=evJson.remaining;
  const marketsStr=markets.slice(0,8).join(','), bookLines={};
  for (let i=0;i<events.length;i++) {
    onProgress(`DK props: game ${i+1} / ${events.length}`);
    try {
      const j=await fetch(`/api/dk-lines?sport=${sportKey}&event_id=${events[i].id}&markets=${marketsStr}`).then(r=>r.json());
      if (j.remaining!=null) remaining=j.remaining;
      for (const bk of j.data?.bookmakers||[]) {
        if (bk.key!=='draftkings') continue;
        for (const mkt of bk.markets||[]) for (const out of mkt.outcomes||[]) {
          const pk=out.name?.toLowerCase(); if(!pk)continue;
          if(!bookLines[pk])bookLines[pk]={};if(!bookLines[pk][mkt.key])bookLines[pk][mkt.key]={};
          bookLines[pk][mkt.key][(out.description||'').toLowerCase()]={line:out.point,odds:out.price};
        }
      }
    } catch(_) {}
    if (i<events.length-1) await new Promise(r=>setTimeout(r,250));
  }
  return {bookLines,remaining};
}
async function fetchKalshiLines() {
  try {
    const d=await fetch('/api/kalshi?limit=200').then(r=>r.json());
    const lines={}, sm={points:'player_points',rebounds:'player_rebounds',assists:'player_assists',goals:'player_goals',strikeouts:'player_strikeouts',hits:'player_hits'};
    for (const m of d?.markets||[]) {
      const title=(m.title||m.question||'').toLowerCase();
      const nm=title.match(/(\d+\.?\d*)\+?\s*(points|rebounds|assists|goals|strikeouts|hits)/);
      if (!nm) continue;
      const mktKey=sm[nm[2]]; if(!mktKey)continue;
      const before=title.split(nm[0])[0].trim(); if(!before)continue;
      if(!lines[before])lines[before]={};
      lines[before][mktKey]={line:parseFloat(nm[1]),yesPrice:m.yes_ask??m.last_price??null};
    }
    return lines;
  } catch(_){return{};}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const MULTIPLIERS={2:3,3:5,4:10,5:20,6:25};
const DIFF_ORDER={goblin:0,standard:1,demon:2,unknown:3};
function fmt(iso){if(!iso)return'';try{return new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true});}catch(_){return'';}}
function trunc(s,n){return s.length>n?s.slice(0,n)+'…':s;}

// ─── Components ───────────────────────────────────────────────────────────────
function GameStatusTag({status}){
  const s={in_progress:{bg:'var(--color-background-warning)',c:'var(--color-text-warning)'},final:{bg:'var(--color-background-secondary)',c:'var(--color-text-tertiary)'},pre_game:{bg:'var(--color-background-success)',c:'var(--color-text-success)'}}[status]||{bg:'var(--color-background-success)',c:'var(--color-text-success)'};
  return <span style={{background:s.bg,color:s.c,fontSize:9,padding:'2px 6px',borderRadius:4,fontFamily:'var(--font-mono)'}}>{status==='in_progress'&&<span style={{display:'inline-block',width:5,height:5,borderRadius:'50%',background:'var(--color-text-warning)',marginRight:3,verticalAlign:1,animation:'pulse-d 1.2s ease-in-out infinite'}}/>}{status==='in_progress'?'live':status==='final'?'final':'pre'}</span>;
}

function InjuryBadge({injury}){
  if (!injury?.injuryStatus) return null;
  const cfgs={
    'Questionable':{bg:'var(--color-background-warning)',c:'var(--color-text-warning)',lbl:'Q'},
    'Doubtful':    {bg:'var(--color-background-warning)',c:'var(--color-text-warning)',lbl:'D'},
    'Out':         {bg:'var(--color-background-danger)', c:'var(--color-text-danger)', lbl:'OUT'},
    'Day-To-Day':  {bg:'var(--color-background-warning)',c:'var(--color-text-warning)',lbl:'DTD'},
    'Injured Reserve':{bg:'var(--color-background-danger)',c:'var(--color-text-danger)',lbl:'IR'},
  };
  const cfg=cfgs[injury.injuryStatus]; if(!cfg)return null;
  const title=injury.injuryDesc?`${injury.injuryStatus} — ${injury.injuryDesc}`:injury.injuryStatus;
  return <span style={{fontSize:9,fontFamily:'var(--font-mono)',fontWeight:500,padding:'1px 4px',borderRadius:3,background:cfg.bg,color:cfg.c,marginLeft:5,letterSpacing:0.5}} title={title}>{cfg.lbl}</span>;
}

// Compact stats row: season · L10 · L5 with color-coded deltas
function StatsRow({statType, playerData, line, loading}){
  if (loading) return <div style={{fontSize:10,color:'var(--color-text-tertiary)',marginBottom:6,minHeight:14,fontFamily:'var(--font-mono)'}}>loading stats...</div>;
  if (!playerData) return <div style={{minHeight:14,marginBottom:6}}/>;
  const {stats={},games=[]} = playerData;
  const szn = computeAvg(statType, stats);
  const l10 = computeRecentAvg(statType, games, 10);
  const l5  = computeRecentAvg(statType, games, 5);
  if (szn==null&&l10==null&&l5==null) return <div style={{fontSize:10,color:'var(--color-text-tertiary)',marginBottom:6}}>avg: n/a for this stat</div>;
  const fmtV = v => v!=null?v.toFixed(1):'—';
  const delta = v => { if(v==null||line==null)return null; return Math.round((v-line)*10)/10; };
  const dColor = d => d==null?'var(--color-text-tertiary)':d>0.5?'var(--color-text-success)':d<-0.5?'var(--color-text-danger)':'var(--color-text-tertiary)';
  const dLabel = d => d==null?'':((d>0?'+':'')+d);
  const Cell = ({label,v})=>{
    const d=delta(v);
    return <div style={{display:'flex',flexDirection:'column',alignItems:'flex-start',gap:1}}>
      <span style={{fontSize:9,color:'var(--color-text-tertiary)',textTransform:'uppercase',letterSpacing:0.5}}>{label}</span>
      <div style={{display:'flex',alignItems:'baseline',gap:3}}>
        <span style={{fontFamily:'var(--font-mono)',fontWeight:500,fontSize:12,color:'var(--color-text-primary)'}}>{fmtV(v)}</span>
        {d!=null&&<span style={{fontFamily:'var(--font-mono)',fontSize:9,color:dColor(d)}}>{dLabel(d)}</span>}
      </div>
    </div>;
  };
  return (
    <div style={{display:'flex',gap:10,marginBottom:7,padding:'5px 0',borderTop:'0.5px solid var(--color-border-tertiary)'}}>
      {szn!=null&&<Cell label="season" v={szn}/>}
      {l10!=null&&<Cell label="L10" v={l10}/>}
      {l5!=null&&<Cell label="L5" v={l5}/>}
    </div>
  );
}

function BookCompare({prop,bookLines,kalshiLines,loading}){
  if(loading)return<div style={{fontSize:10,color:'var(--color-text-tertiary)',fontFamily:'var(--font-mono)',padding:'4px 0',borderTop:'0.5px solid var(--color-border-tertiary)'}}>loading book lines...</div>;
  if(!bookLines&&!kalshiLines)return null;
  const mkt=PP_TO_MARKET[prop.statType],ppLine=prop.line;
  const dkMatch=mkt?lookupBookLine(prop.player,mkt,bookLines):null;
  const dkLine=dkMatch?.data?.over?.line??dkMatch?.data?.under?.line??null;
  const dkDelta=dkLine!=null&&ppLine!=null?Math.round((dkLine-ppLine)*10)/10:null;
  let kalLine=null,kalProb=null;
  if(kalshiLines&&mkt){const pk=prop.player.toLowerCase();for(const[k,v]of Object.entries(kalshiLines)){if(pk.includes(k)||k.includes(pk.split(' ').pop())){if(v[mkt]){kalLine=v[mkt].line;kalProb=v[mkt].yesPrice;break;}}}}
  if(!dkLine&&!kalLine)return null;
  const dStyle=d=>({fontFamily:'var(--font-mono)',fontSize:9,color:d>0?'var(--color-text-success)':d<0?'var(--color-text-danger)':'var(--color-text-tertiary)'});
  const valBadge=dkDelta!=null&&Math.abs(dkDelta)>=0.5?<span style={{fontSize:8,fontFamily:'var(--font-mono)',fontWeight:500,padding:'1px 4px',borderRadius:3,marginLeft:3,background:dkDelta<0?'var(--color-background-success)':'var(--color-background-danger)',color:dkDelta<0?'var(--color-text-success)':'var(--color-text-danger)'}} title={dkDelta<0?'PP higher — consider less':'PP lower — consider more'}>{dkDelta<0?'↑val':'↓val'}</span>:null;
  return(
    <div style={{borderTop:'0.5px solid var(--color-border-tertiary)',padding:'4px 0',marginBottom:6}}>
      <div style={{display:'flex',alignItems:'center'}}>
        <div style={{flex:1,display:'flex',alignItems:'baseline',gap:3}}>
          <span style={{fontSize:9,fontFamily:'var(--font-mono)',color:'var(--color-text-tertiary)',textTransform:'uppercase',letterSpacing:0.5,minWidth:20}}>DK</span>
          {dkLine!=null?<><span style={{fontFamily:'var(--font-mono)',fontSize:12,fontWeight:500,color:'var(--color-text-primary)'}}>{dkLine}</span>{dkDelta!=null&&<span style={dStyle(dkDelta)}>{dkDelta>0?'+':''}{dkDelta}</span>}{valBadge}</>:<span style={{fontSize:10,color:'var(--color-text-tertiary)',fontFamily:'var(--font-mono)'}}>—</span>}
        </div>
        {kalLine!=null&&<div style={{width:'0.5px',height:14,background:'var(--color-border-tertiary)',margin:'0 8px',flexShrink:0}}/>}
        {kalLine!=null&&<div style={{display:'flex',alignItems:'baseline',gap:3}}><span style={{fontSize:9,fontFamily:'var(--font-mono)',color:'var(--color-text-tertiary)',textTransform:'uppercase',letterSpacing:0.5,minWidth:20}}>KAL</span><span style={{fontFamily:'var(--font-mono)',fontSize:12,fontWeight:500,color:'var(--color-text-primary)'}}>{kalLine}</span>{kalProb!=null&&<span style={{fontFamily:'var(--font-mono)',fontSize:9,color:'var(--color-text-info)'}}>{Math.round(kalProb)}%</span>}</div>}
      </div>
      {dkMatch?.matched==='fuzzy'&&<div style={{fontSize:9,color:'var(--color-text-tertiary)',fontFamily:'var(--font-mono)',marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>dk: {trunc(dkMatch.dkName,20)}</div>}
    </div>
  );
}

function PropCard({prop,pick,onPick,playerData,statsLoading,bookLines,kalshiLines,booksLoading}){
  const isOver=pick==='over',isUnder=pick==='under',isGoblin=prop.diff==='goblin';
  const cardBorder=isOver?'var(--color-border-success)':isUnder?'var(--color-border-danger)':'var(--color-border-tertiary)';
  const cardBg=isOver?'var(--color-background-success)':isUnder?'var(--color-background-danger)':'var(--color-background-primary)';
  const ouBase={flex:1,padding:'5px 0',fontSize:11,fontWeight:500,fontFamily:'var(--font-sans)',borderRadius:'var(--border-radius-md)',cursor:'pointer',border:'0.5px solid var(--color-border-secondary)',background:'var(--color-background-secondary)',color:'var(--color-text-secondary)',display:'flex',alignItems:'center',justifyContent:'center',gap:4};
  return(
    <div style={{background:cardBg,border:`0.5px solid ${cardBorder}`,borderRadius:'var(--border-radius-lg)',padding:'11px 13px',position:'relative'}}>
      {isGoblin&&<span style={{position:'absolute',top:7,right:7,fontSize:9,fontFamily:'var(--font-mono)',fontWeight:500,background:'var(--color-background-success)',color:'var(--color-text-success)',padding:'1px 5px',borderRadius:3}}>goblin</span>}
      {prop.diff==='demon'&&<span style={{position:'absolute',top:10,right:10,width:6,height:6,borderRadius:'50%',background:'var(--color-text-danger)',display:'block'}} title="Demon"/>}
      {/* Player name + injury badge */}
      <div style={{display:'flex',alignItems:'center',marginBottom:2,maxWidth:'calc(100% - 50px)'}}>
        <div style={{fontWeight:500,fontSize:13,color:'var(--color-text-primary)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{prop.player}</div>
        <InjuryBadge injury={playerData?.injury}/>
      </div>
      <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:7}}>
        {prop.team&&<span style={{fontSize:10,color:'var(--color-text-secondary)',fontFamily:'var(--font-mono)',background:'var(--color-background-secondary)',padding:'1px 5px',borderRadius:3}}>{prop.team}</span>}
        {prop.position&&<span style={{fontSize:10,color:'var(--color-text-tertiary)'}}>{prop.position}</span>}
      </div>
      {/* Line */}
      <div style={{display:'flex',alignItems:'baseline',gap:6,padding:'6px 0',borderTop:'0.5px solid var(--color-border-tertiary)',borderBottom:'0.5px solid var(--color-border-tertiary)',marginBottom:6}}>
        <span style={{fontFamily:'var(--font-mono)',fontSize:24,fontWeight:500,color:'var(--color-text-success)',lineHeight:1}}>{prop.line??'—'}</span>
        <span style={{fontSize:10,color:'var(--color-text-secondary)',textTransform:'uppercase',letterSpacing:0.5,flex:1}}>{prop.statType}</span>
        <GameStatusTag status={prop.status}/>
      </div>
      {/* Season / L10 / L5 averages */}
      <StatsRow statType={prop.statType} playerData={playerData} line={prop.line} loading={statsLoading}/>
      {/* Book comparison */}
      <BookCompare prop={prop} bookLines={bookLines} kalshiLines={kalshiLines} loading={booksLoading}/>
      {/* Over/Under */}
      <div style={{display:'flex',gap:6}}>
        <button style={{...ouBase,...(isOver?{background:'var(--color-background-success)',borderColor:'var(--color-border-success)',color:'var(--color-text-success)'}:{})}} onClick={()=>onPick(prop,isOver?'remove':'over')}><i className="ti ti-arrow-up" aria-hidden="true" style={{fontSize:12}}/>{isOver?'added':'more'}</button>
        <button style={{...ouBase,...(isUnder?{background:'var(--color-background-danger)',borderColor:'var(--color-border-danger)',color:'var(--color-text-danger)'}:{}),...(isGoblin?{opacity:0.28,cursor:'not-allowed'}:{})}} onClick={isGoblin?undefined:()=>onPick(prop,isUnder?'remove':'under')} disabled={isGoblin} title={isGoblin?'Goblin — more only':undefined}><i className="ti ti-arrow-down" aria-hidden="true" style={{fontSize:12}}/>{isGoblin?'—':isUnder?'added':'less'}</button>
      </div>
    </div>
  );
}

function ParlaySlip({picks,onRemove,onClear}){
  const[open,setOpen]=useState(true);const[entry,setEntry]=useState('5');
  const count=picks.length,mult=MULTIPLIERS[count]||null,payout=mult?Math.round(parseFloat(entry||0)*mult*100)/100:0;
  return(
    <div style={{position:'fixed',bottom:0,left:0,right:0,background:'var(--color-background-primary)',borderTop:'0.5px solid var(--color-border-secondary)',zIndex:200}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 16px',height:48,cursor:'pointer',userSelect:'none'}} onClick={()=>setOpen(o=>!o)}>
        <div style={{display:'flex',alignItems:'center',gap:8,fontWeight:500,fontSize:13,color:'var(--color-text-primary)'}}><i className="ti ti-receipt" aria-hidden="true" style={{fontSize:15}}/>parlay slip{count>0&&<span style={{background:'var(--color-background-info)',color:'var(--color-text-info)',fontFamily:'var(--font-mono)',fontSize:10,padding:'2px 7px',borderRadius:10}}>{count}</span>}</div>
        {count>0&&!open&&<span style={{fontFamily:'var(--font-mono)',fontSize:12,color:'var(--color-text-success)'}}>${payout.toFixed(2)} to win</span>}
        <i className={`ti ${open?'ti-chevron-down':'ti-chevron-up'}`} aria-hidden="true" style={{fontSize:14,color:'var(--color-text-secondary)'}}/>
      </div>
      {open&&<div style={{padding:'0 16px 14px',overflowY:'auto',maxHeight:200}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,flexWrap:'wrap'}}>
          <div style={{display:'flex',alignItems:'center',gap:5}}><span style={{fontSize:12,color:'var(--color-text-secondary)'}}>entry $</span><input style={{width:70,background:'var(--color-background-secondary)',border:'0.5px solid var(--color-border-tertiary)',borderRadius:'var(--border-radius-md)',color:'var(--color-text-primary)',fontFamily:'var(--font-mono)',fontSize:13,padding:'5px 8px',outline:'none',textAlign:'right'}} type="number" min={1} step={1} value={entry} onChange={e=>setEntry(e.target.value)}/></div>
          {mult&&<span style={{fontSize:10,color:'var(--color-text-tertiary)',fontFamily:'var(--font-mono)'}}>{count}-pick · {mult}x</span>}
          <button style={{marginLeft:'auto',fontSize:11,color:'var(--color-text-secondary)',background:'none',border:'0.5px solid var(--color-border-tertiary)',borderRadius:'var(--border-radius-md)',padding:'4px 9px',cursor:'pointer',fontFamily:'var(--font-sans)'}} onClick={onClear}>clear all</button>
        </div>
        {count===0&&<p style={{fontSize:12,color:'var(--color-text-tertiary)',textAlign:'center',padding:'12px 0'}}>tap more / less on any prop to build your parlay</p>}
        <div style={{display:'flex',flexDirection:'column',gap:5}}>
          {picks.map(pk=><div key={pk.id} style={{display:'flex',alignItems:'center',gap:6,padding:'5px 9px',background:'var(--color-background-secondary)',borderRadius:'var(--border-radius-md)'}}><span style={{fontSize:12,fontWeight:500,color:'var(--color-text-primary)',flex:1,minWidth:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{pk.player}</span><span style={{fontSize:10,color:'var(--color-text-secondary)',whiteSpace:'nowrap'}}>{pk.line} {pk.statType}</span><span style={{fontSize:10,fontWeight:500,padding:'2px 6px',borderRadius:4,...(pk.direction==='over'?{background:'var(--color-background-success)',color:'var(--color-text-success)'}:{background:'var(--color-background-danger)',color:'var(--color-text-danger)'})}}>{pk.direction==='over'?'more':'less'}</span><button style={{background:'none',border:'none',color:'var(--color-text-tertiary)',cursor:'pointer',fontSize:14,padding:'0 2px',lineHeight:1}} onClick={()=>onRemove(pk.id)}>×</button></div>)}
        </div>
        {count>0&&mult&&<div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:10,paddingTop:8,borderTop:'0.5px solid var(--color-border-tertiary)'}}><span style={{fontSize:11,color:'var(--color-text-secondary)'}}>potential payout</span><div style={{textAlign:'right'}}><div style={{fontFamily:'var(--font-mono)',fontSize:16,fontWeight:500,color:'var(--color-text-success)'}}>${payout.toFixed(2)}</div><div style={{fontSize:10,color:'var(--color-text-tertiary)',fontFamily:'var(--font-mono)'}}>${parseFloat(entry||0).toFixed(2)} × {mult}x</div></div></div>}
      </div>}
    </div>
  );
}

function DebugPanel({rawDebug}){
  const[open,setOpen]=useState(false);
  return(<div style={{marginTop:20,border:'0.5px solid var(--color-border-tertiary)',borderRadius:'var(--border-radius-lg)'}}><div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',cursor:'pointer',fontSize:12,color:'var(--color-text-secondary)'}} onClick={()=>setOpen(o=>!o)}><i className="ti ti-bug" aria-hidden="true" style={{fontSize:14}}/>raw pp field names (first prop)<i className={`ti ${open?'ti-chevron-up':'ti-chevron-down'}`} aria-hidden="true" style={{fontSize:12,marginLeft:'auto'}}/></div>{open&&<div style={{padding:'10px 12px',borderTop:'0.5px solid var(--color-border-tertiary)',overflowX:'auto'}}><pre style={{fontFamily:'var(--font-mono)',fontSize:10,color:'var(--color-text-secondary)',whiteSpace:'pre-wrap',wordBreak:'break-all',lineHeight:1.5}}>{JSON.stringify(rawDebug,null,2)}</pre></div>}</div>);
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App(){
  const[allProps,setAllProps]=useState([]);const[rawDebug,setRawDebug]=useState(null);
  const[activeLeague,setActiveLeague]=useState('');const[search,setSearch]=useState('');
  const[sortByLikely,setSortByLikely]=useState(false);const[loading,setLoading]=useState(true);
  const[error,setError]=useState(null);const[lastUpdated,setLastUpdated]=useState(null);
  const[picks,setPicks]=useState([]);
  // statsCache now stores { playerName: { stats, games, injury } }
  const[statsCache,setStatsCache]=useState({});
  const[statsProgress,setStatsProgress]=useState({loading:false,current:0,total:0});
  const[bookCache,setBookCache]=useState({});const[booksProgress,setBooksProgress]=useState({loading:false,msg:''});
  const[requestsLeft,setRequestsLeft]=useState(null);

  const load=useCallback(async()=>{setLoading(true);setError(null);try{const raw=await fetchPP();const{props,rawDebug:d}=parsePP(raw);setAllProps(props);setRawDebug(d);setLastUpdated(new Date());}catch(e){setError(e.message);}finally{setLoading(false);};},[]);
  useEffect(()=>{load();},[load]);useEffect(()=>{const t=setInterval(load,3*60*1000);return()=>clearInterval(t);},[load]);

  const leagues=useMemo(()=>{const m={};for(const p of allProps)if(p.leagueName&&p.leagueId)m[p.leagueId]=p.leagueName;return Object.entries(m).map(([id,name])=>({id,name}));},[allProps]);
  const activeLeagueName=useMemo(()=>leagues.find(l=>l.id===activeLeague)?.name||'',[leagues,activeLeague]);
  const filtered=useMemo(()=>{let r=allProps;if(activeLeague)r=r.filter(p=>p.leagueId===activeLeague);if(search.trim()){const q=search.trim().toLowerCase();r=r.filter(p=>p.player.toLowerCase().includes(q)||p.statType.toLowerCase().includes(q)||p.team.toLowerCase().includes(q));}if(sortByLikely)r=[...r].sort((a,b)=>(DIFF_ORDER[a.diff]??3)-(DIFF_ORDER[b.diff]??3));return r;},[allProps,activeLeague,search,sortByLikely]);
  const grouped=useMemo(()=>groupProps(filtered),[filtered]);
  const visibleLeagues=useMemo(()=>Object.values(grouped).sort((a,b)=>a.name.localeCompare(b.name)),[grouped]);
  const pickMap=useMemo(()=>{const m={};for(const pk of picks)m[pk.id]=pk.direction;return m;},[picks]);

  const handlePick=(prop,action)=>{if(action==='remove'){setPicks(p=>p.filter(x=>x.id!==prop.id));return;}if(picks.length>=6&&!pickMap[prop.id])return;setPicks(p=>[...p.filter(x=>x.id!==prop.id),{...prop,direction:action}]);};

  const handleLoadStats=useCallback(async()=>{
    if(!activeLeague||statsProgress.loading)return;
    const cfg=leagueToEspn(activeLeagueName);if(!cfg)return;
    const names=[...new Set(allProps.filter(p=>p.leagueId===activeLeague).map(p=>p.player))];
    setStatsProgress({loading:true,current:0,total:names.length});
    const res=await loadPlayerStats(names,cfg,(cur,tot)=>setStatsProgress({loading:true,current:cur,total:tot}));
    setStatsCache(prev=>({...prev,[activeLeague]:res}));
    setStatsProgress({loading:false,current:names.length,total:names.length});
  },[activeLeague,activeLeagueName,allProps,statsProgress.loading]);

  const handleLoadBooks=useCallback(async()=>{
    if(!activeLeague||booksProgress.loading)return;setBooksProgress({loading:true,msg:'Starting...'});
    const lp=allProps.filter(p=>p.leagueId===activeLeague);
    try{const[{bookLines,remaining},kalshiLines]=await Promise.all([fetchDKLines(activeLeagueName,lp,msg=>setBooksProgress({loading:true,msg})),fetchKalshiLines()]);if(remaining!=null)setRequestsLeft(remaining);setBookCache(prev=>({...prev,[activeLeague]:{bookLines:bookLines||{},kalshiLines:kalshiLines||{}}}));}
    catch(e){alert('Book lines error: '+e.message);}setBooksProgress({loading:false,msg:''});
  },[activeLeague,activeLeagueName,allProps,booksProgress.loading]);

  const currentStats=statsCache[activeLeague]||null,currentBooks=bookCache[activeLeague]||null;
  const statsHaveData=!!(currentStats&&Object.keys(currentStats).length),booksHaveData=!!currentBooks;
  const espnOk=!!leagueToEspn(activeLeagueName),oddsOk=!!SPORT_TO_ODDSAPI[activeLeagueName.toLowerCase()];
  const tabSt=(act)=>({background:act?'var(--color-background-info)':'var(--color-background-secondary)',border:`0.5px solid ${act?'var(--color-border-info)':'var(--color-border-tertiary)'}`,borderRadius:'var(--border-radius-md)',color:act?'var(--color-text-info)':'var(--color-text-secondary)',fontWeight:act?500:400,fontSize:12,padding:'5px 13px',cursor:'pointer',whiteSpace:'nowrap',fontFamily:'var(--font-sans)'});
  const btnSt=(v)=>{const b={display:'flex',alignItems:'center',gap:5,background:'none',border:'0.5px solid var(--color-border-secondary)',color:'var(--color-text-secondary)',fontFamily:'var(--font-sans)',fontSize:12,padding:'5px 11px',borderRadius:'var(--border-radius-md)',cursor:'pointer',whiteSpace:'nowrap'};return v==='success'?{...b,background:'var(--color-background-success)',borderColor:'var(--color-border-success)',color:'var(--color-text-success)'}:v==='info'?{...b,background:'var(--color-background-info)',borderColor:'var(--color-border-info)',color:'var(--color-text-info)'}:b;};

  return(
    <div style={{minHeight:'100vh',fontFamily:'var(--font-sans)',paddingBottom:145}}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse-d{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
      {/* Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',paddingBottom:12,borderBottom:'0.5px solid var(--color-border-tertiary)',marginBottom:12}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}><span style={{background:'var(--color-background-success)',color:'var(--color-text-success)',fontFamily:'var(--font-mono)',fontWeight:500,fontSize:11,padding:'3px 7px',borderRadius:5,letterSpacing:1}}>PP</span><span style={{fontWeight:500,fontSize:14,letterSpacing:2,color:'var(--color-text-primary)'}}>TRACKER</span></div>
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          {lastUpdated&&<span style={{fontSize:11,color:'var(--color-text-tertiary)',fontFamily:'var(--font-mono)'}}>upd {lastUpdated.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</span>}
          <button style={btnSt()} onClick={load} disabled={loading}><i className="ti ti-refresh" aria-hidden="true" style={{fontSize:13,...(loading?{animation:'spin 1s linear infinite'}:{})}}/>{loading?'loading...':'refresh'}</button>
        </div>
      </div>
      {/* Controls */}
      <div style={{display:'flex',flexDirection:'column',gap:9,marginBottom:12}}>
        <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
          <div style={{position:'relative',maxWidth:260}}>
            <i className="ti ti-search" aria-hidden="true" style={{position:'absolute',left:9,top:'50%',transform:'translateY(-50%)',color:'var(--color-text-secondary)',fontSize:16,pointerEvents:'none'}}/>
            <input style={{width:'100%',background:'var(--color-background-secondary)',border:'0.5px solid var(--color-border-tertiary)',borderRadius:'var(--border-radius-md)',color:'var(--color-text-primary)',fontFamily:'var(--font-sans)',fontSize:13,padding:'7px 28px 7px 32px',outline:'none'}} type="text" placeholder="search player, stat, team..." value={search} onChange={e=>setSearch(e.target.value)}/>
            {search&&<button style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:'var(--color-text-secondary)',cursor:'pointer',fontSize:13,lineHeight:1,padding:2}} onClick={()=>setSearch('')}>✕</button>}
          </div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <span style={{fontSize:11,color:'var(--color-text-secondary)'}}>sort:</span>
            {[['default',!sortByLikely,()=>setSortByLikely(false)],['most likely first',sortByLikely,()=>setSortByLikely(true)]].map(([l,a,f])=><button key={l} style={{fontSize:11,padding:'4px 10px',border:'0.5px solid var(--color-border-tertiary)',borderRadius:'var(--border-radius-md)',background:a?'var(--color-background-success)':'none',borderColor:a?'var(--color-border-success)':undefined,color:a?'var(--color-text-success)':'var(--color-text-secondary)',cursor:'pointer',fontFamily:'var(--font-sans)'}} onClick={f}>{l}</button>)}
          </div>
        </div>
        {leagues.length>0&&<div style={{display:'flex',gap:6,overflowX:'auto',paddingBottom:2}}><button style={tabSt(activeLeague==='')} onClick={()=>setActiveLeague('')}>all</button>{leagues.map(t=><button key={t.id} style={tabSt(activeLeague===t.id)} onClick={()=>setActiveLeague(t.id)}>{t.name}</button>)}</div>}
        {/* Action bar */}
        <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',background:'var(--color-background-secondary)',border:'0.5px solid var(--color-border-tertiary)',borderRadius:'var(--border-radius-md)',flexWrap:'wrap',minHeight:42}}>
          {!activeLeague?<span style={{fontSize:11,color:'var(--color-text-tertiary)'}}>select a sport tab to load stats &amp; book lines</span>:<>
            {espnOk?<button style={btnSt(statsHaveData?'success':'')} onClick={handleLoadStats} disabled={statsProgress.loading}><i className="ti ti-chart-bar" aria-hidden="true" style={{fontSize:13}}/>{statsProgress.loading?'fetching stats...':statsHaveData?'reload stats':'load ESPN stats'}</button>:<span style={{fontSize:11,color:'var(--color-text-tertiary)'}}>ESPN: NBA·MLB·NHL·NFL</span>}
            {statsProgress.loading&&<div style={{display:'flex',alignItems:'center',gap:6,flex:1}}><div style={{flex:1,height:4,background:'var(--color-border-tertiary)',borderRadius:2,overflow:'hidden',minWidth:60}}><div style={{width:(statsProgress.total?Math.round(statsProgress.current/statsProgress.total*100):0)+'%',height:'100%',background:'var(--color-text-success)',borderRadius:2,transition:'width 0.3s'}}/></div><span style={{fontSize:11,color:'var(--color-text-secondary)',fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>{statsProgress.current}/{statsProgress.total}</span></div>}
            {espnOk&&<div style={{width:'0.5px',height:20,background:'var(--color-border-tertiary)',flexShrink:0}}/>}
            {oddsOk?<button style={btnSt(booksHaveData?'info':'')} onClick={handleLoadBooks} disabled={booksProgress.loading}><i className="ti ti-arrows-exchange" aria-hidden="true" style={{fontSize:13}}/>{booksProgress.loading?(booksProgress.msg||'fetching...'):booksHaveData?'reload book lines':'load DK + Kalshi'}</button>:<span style={{fontSize:11,color:'var(--color-text-tertiary)'}}>book lines: NBA·MLB·NHL·NFL</span>}
            {booksProgress.loading&&booksProgress.msg&&<span style={{fontSize:11,color:'var(--color-text-secondary)',fontFamily:'var(--font-mono)'}}>{booksProgress.msg}</span>}
            {requestsLeft!=null&&<span style={{marginLeft:'auto',fontSize:11,fontFamily:'var(--font-mono)',color:requestsLeft<50?'var(--color-text-warning)':'var(--color-text-tertiary)'}}><span style={{color:requestsLeft<50?'var(--color-text-warning)':'var(--color-text-success)',fontWeight:500}}>{requestsLeft}</span> req left</span>}
          </>}
        </div>
      </div>
      {loading&&<div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:240,gap:12}}><div style={{width:26,height:26,border:'2px solid var(--color-border-tertiary)',borderTop:'2px solid var(--color-text-success)',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/><p style={{fontSize:12,color:'var(--color-text-secondary)',fontFamily:'var(--font-mono)'}}>pulling lines from prizepicks...</p></div>}
      {error&&!loading&&<div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:240}}><div style={{background:'var(--color-background-danger)',border:'0.5px solid var(--color-border-danger)',borderRadius:'var(--border-radius-lg)',padding:'16px 20px',textAlign:'center',maxWidth:300}}><div style={{fontWeight:500,fontSize:13,color:'var(--color-text-danger)',marginBottom:4}}>couldn't load props</div><div style={{fontSize:11,color:'var(--color-text-danger)',fontFamily:'var(--font-mono)',marginBottom:10,opacity:0.8,wordBreak:'break-word'}}>{error}</div><button style={{background:'none',border:'0.5px solid var(--color-border-danger)',color:'var(--color-text-danger)',fontFamily:'var(--font-sans)',fontSize:12,padding:'5px 14px',borderRadius:'var(--border-radius-md)',cursor:'pointer'}} onClick={load}>try again</button></div></div>}
      {!loading&&!error&&visibleLeagues.map(lg=>(
        <div key={lg.id}>
          {visibleLeagues.length>1&&<div style={{fontSize:11,fontWeight:500,letterSpacing:1,color:'var(--color-text-tertiary)',textTransform:'uppercase',marginBottom:10,padding:'4px 0',borderBottom:'0.5px solid var(--color-border-tertiary)'}}>{lg.name}</div>}
          {Object.entries(lg.games).map(([gid,game])=>(
            <div key={gid} style={{marginBottom:18}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8,paddingBottom:6,borderBottom:'0.5px solid var(--color-border-tertiary)',flexWrap:'wrap'}}>
                <span style={{fontFamily:'var(--font-mono)',fontSize:11,fontWeight:500,color:'var(--color-text-primary)'}}>{game.label||'matchup'}</span>
                {game.startTime&&<span style={{fontSize:10,color:'var(--color-text-tertiary)',fontFamily:'var(--font-mono)'}}>{fmt(game.startTime)}</span>}
                <GameStatusTag status={game.status}/>
                <span style={{fontSize:10,color:'var(--color-text-tertiary)',marginLeft:'auto'}}>{game.props.length} props</span>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:8}}>
                {game.props.map(p=><PropCard key={p.id} prop={p} pick={pickMap[p.id]} onPick={handlePick}
                  playerData={currentStats?.[p.player]||null} statsLoading={statsProgress.loading}
                  bookLines={currentBooks?.bookLines||null} kalshiLines={currentBooks?.kalshiLines||null} booksLoading={booksProgress.loading}/>)}
              </div>
            </div>
          ))}
        </div>
      ))}
      {!loading&&!error&&rawDebug&&<DebugPanel rawDebug={rawDebug}/>}
      <ParlaySlip picks={picks} onRemove={id=>setPicks(p=>p.filter(x=>x.id!==id))} onClear={()=>setPicks([])}/>
    </div>
  );
}
