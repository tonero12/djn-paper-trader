import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  PieChart,
  Settings,
  HelpCircle,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  AlertTriangle,
  Send,
  Image as ImageIcon,
  CheckCircle,
  Activity,
  Terminal,
  Layers,
  Award,
  GitBranch,
  Download,
  UploadCloud,
  Copy,
  Check,
} from 'lucide-react';

interface BotStatus {
  status: string;
  appName: string;
  botConfigured: boolean;
  botInfo?: {
    id?: number;
    first_name?: string;
    username?: string;
  } | null;
  publicBaseUrl: string;
  webhookPath: string;
  expectedWebhookUrl: string;
  telegramWebhookInfo: any;
  storage: {
    type: string;
    gcpProject: string;
    databaseId: string;
  };
  pollingStatus?: {
    isActive: boolean;
    conflictDetected: boolean;
    isPaused: boolean;
    lastError: string | null;
  };
}

interface AccountOverview {
  user: any;
  session: any;
  positions: any[];
  history: any[];
  stats: any;
}

export default function App() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchAddr, setSearchAddr] = useState('');
  const [selectedChain, setSelectedChain] = useState<string>('solana');
  const [activeTab, setActiveTab] = useState<'trade' | 'positions' | 'performance' | 'botguide' | 'hosting' | 'github'>('trade');
  const [quote, setQuote] = useState<any>(null);
  const [buySpend, setBuySpend] = useState('50');
  const [previewData, setPreviewData] = useState<any>(null);
  const [sellPreviewData, setSellPreviewData] = useState<any>(null);
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // GitHub & Export states
  const [gitRepoUrl, setGitRepoUrl] = useState('');
  const [gitToken, setGitToken] = useState('');
  const [gitBranchName, setGitBranchName] = useState('main');
  const [gitForce, setGitForce] = useState(false);
  const [gitPushing, setGitPushing] = useState(false);
  const [gitPushResult, setGitPushResult] = useState<{ success: boolean; message: string; output?: string } | null>(null);
  const [gitInfo, setGitInfo] = useState<{
    branch: string;
    totalCommits: number;
    latestCommit: { hash: string; author: string; message: string; date: string };
    remoteUrl: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Load Status, Overview and Git Info on Mount
  useEffect(() => {
    fetchStatus();
    fetchOverview();
    fetchGitInfo();
  }, []);

  const fetchGitInfo = async () => {
    try {
      const res = await fetch('/api/git/info');
      const data = await res.json();
      if (!data.error) {
        setGitInfo(data);
        if (data.remoteUrl && !gitRepoUrl) {
          setGitRepoUrl(data.remoteUrl);
        }
      }
    } catch (e) {
      console.error('Failed to fetch git info', e);
    }
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const handleTogglePolling = async () => {
    try {
      const endpoint = status?.pollingStatus?.isPaused ? '/api/bot/resume-polling' : '/api/bot/pause-polling';
      await fetch(endpoint, { method: 'POST' });
      await fetchStatus();
      setNotice(
        status?.pollingStatus?.isPaused
          ? '▶️ Local polling resumed.'
          : '⏸️ Local bot polling paused. Your live 24/7 cloud bot (on Railway/Render) can now run completely uninterrupted!'
      );
    } catch (err: any) {
      setNotice(`Error: ${err.message}`);
    }
  };

  const handleGitPush = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gitRepoUrl.trim()) {
      setNotice('Please enter your GitHub repository URL.');
      return;
    }
    setGitPushing(true);
    setGitPushResult(null);
    try {
      const res = await fetch('/api/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: gitRepoUrl.trim(),
          token: gitToken.trim(),
          branch: gitBranchName.trim() || 'main',
          force: gitForce,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to push to GitHub');
      }
      setGitPushResult({
        success: true,
        message: data.message || 'Pushed successfully!',
        output: data.output,
      });
      fetchGitInfo();
      setNotice('🎉 Pushed cleanly to GitHub repository!');
    } catch (err: any) {
      setGitPushResult({
        success: false,
        message: err.message,
      });
      setNotice(`❌ Push error: ${err.message}`);
    } finally {
      setGitPushing(false);
    }
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error('Failed to fetch status', err);
    }
  };

  const fetchOverview = async () => {
    try {
      const res = await fetch('/api/simulator/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_overview' }),
      });
      const data = await res.json();
      setOverview(data);
    } catch (err) {
      console.error('Failed to fetch overview', err);
    }
  };

  const handleLookup = async (addr?: string, chain?: any) => {
    const address = addr || searchAddr.trim();
    const ch = chain || selectedChain;
    if (!address) return;

    setLoading(true);
    setNotice(null);
    try {
      const res = await fetch('/api/simulator/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'quote',
          payload: { address, chain: ch },
        }),
      });
      const data = await res.json();
      if (data.quote) {
        setQuote(data.quote);
      } else {
        setNotice('No trading pair found on DEX Screener for this address.');
        setQuote(null);
      }
    } catch (err: any) {
      setNotice(err.message || 'Failed to fetch quote');
    } finally {
      setLoading(false);
    }
  };

  const handlePrepareBuy = async (amount: string) => {
    if (!quote) return;
    setLoading(true);
    setNotice(null);
    try {
      const res = await fetch('/api/simulator/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'buy_preview',
          payload: {
            address: quote.token.address,
            chain: quote.token.chain,
            spendAmount: amount,
          },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPreviewData(data);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmBuy = async () => {
    if (!previewData) return;
    setLoading(true);
    try {
      const res = await fetch('/api/simulator/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'confirm_buy',
          payload: { intentId: previewData.preview.intentId },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setNotice(`✅ Paper buy executed: ${parseFloat(data.fill.quantity).toFixed(2)} ${data.fill.symbol}!`);
      setPreviewData(null);
      await fetchOverview();
      setActiveTab('positions');
    } catch (err: any) {
      setNotice(`❌ Execution error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handlePrepareSell = async (posId: string, frac: string) => {
    setLoading(true);
    setNotice(null);
    try {
      const res = await fetch('/api/simulator/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sell_preview',
          payload: { positionId: posId, sellFraction: frac },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSellPreviewData(data);
    } catch (err: any) {
      setNotice(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmSell = async () => {
    if (!sellPreviewData) return;
    setLoading(true);
    try {
      const res = await fetch('/api/simulator/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'confirm_sell',
          payload: { intentId: sellPreviewData.preview.intentId },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setNotice(`✅ Paper sell executed: Realised P&L $${parseFloat(data.realisedPnlUsd).toFixed(2)}`);
      setSellPreviewData(null);
      await fetchOverview();
    } catch (err: any) {
      setNotice(`❌ Sell error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleResetSession = async () => {
    if (!window.confirm('Reset your practice session to $1,000.00? (Historical records remain saved).')) return;
    try {
      await fetch('/api/simulator/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset_account' }),
      });
      setNotice('✅ Practice account reset to $1,000.00 USD.');
      await fetchOverview();
    } catch (err: any) {
      setNotice(err.message);
    }
  };

  const sampleTokens = [
    { name: 'BONK (Solana)', addr: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', chain: 'solana' },
    { name: 'SLP (Ronin)', addr: '0x078a0a163e775664cf853170714383fa34d0ddae', chain: 'ronin' },
    { name: 'AXS (Ronin)', addr: '0x97a9107f1793bc407d6f527b77e7fff4d812bece', chain: 'ronin' },
    { name: 'BRETT (Base)', addr: '0x532f27101965dd16442e59d40670faf5ebb142e4', chain: 'base' },
    { name: 'PEPE (Ethereum)', addr: '0x6982508145454ce325ddbe47a25d4ec3d2311933', chain: 'ethereum' },
  ];

  return (
    <div className="min-h-screen bg-[#0E1217] text-slate-100 font-sans flex flex-col">
      {/* Top Banner: Realism & Disclaimer */}
      <div className="bg-[#181F2A] border-b border-slate-800 px-4 py-2 text-xs flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="bg-amber-500/20 text-amber-400 font-bold px-2 py-0.5 rounded text-[11px] border border-amber-500/30">
            SIMULATED FUNDS ONLY
          </span>
          <span className="text-slate-400">
            Manual practice tool • Real DEX Screener market data • No wallet connection or blockchain deposits
          </span>
        </div>
        <div className="flex items-center gap-4 text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${status?.botConfigured ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
            {status?.botConfigured ? 'Telegram Bot Active' : 'Waiting for TELEGRAM_BOT_TOKEN'}
          </span>
          <span className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-blue-400" />
            {status?.storage.type === 'firestore' ? 'Google Cloud Firestore' : 'In-Memory DB (Dev)'}
          </span>
        </div>
      </div>

      {/* Main App Navigation Header */}
      <header className="border-b border-slate-800 bg-[#121721] px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center font-black text-xl text-white shadow-lg shadow-blue-500/20">
            DJN
          </div>
          <div>
            <h1 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
              DJN Paper Trader
              <span className="text-[10px] bg-blue-900/50 text-blue-300 px-2 py-0.5 rounded border border-blue-700/50">
                v1.0.0
              </span>
            </h1>
            <p className="text-xs text-slate-400">Memecoin Practice Trading Simulator & Telegram Webhook Engine</p>
          </div>
        </div>

        {/* Balance & Bot Status Snapshot */}
        <div className="flex flex-wrap items-center gap-3">
          {status?.botInfo && (
            <a
              href={`https://t.me/${status.botInfo.username}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 bg-emerald-950/60 border border-emerald-500/40 rounded-xl px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-900/60 transition group"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>@{status.botInfo.username}</span>
              <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono">
                ONLINE
              </span>
            </a>
          )}

          <div className="flex items-center gap-3 bg-[#1A212D] border border-slate-700/60 rounded-xl px-4 py-2">
            <div>
              <div className="text-[10px] uppercase font-semibold text-slate-400 tracking-wider">Available Cash</div>
              <div className="text-lg font-bold text-emerald-400">
                ${overview?.session ? parseFloat(overview.session.cashBalance).toFixed(2) : '1,000.00'}
              </div>
            </div>
            <div className="h-8 w-px bg-slate-700/80 mx-1" />
            <div>
              <div className="text-[10px] uppercase font-semibold text-slate-400 tracking-wider">Total Equity</div>
              <div className="text-lg font-bold text-white">
                ${overview?.stats ? parseFloat(overview.stats.totalAccountEquityUsd).toFixed(2) : '1,000.00'}
              </div>
            </div>
            <button
              onClick={fetchOverview}
              className="ml-2 p-1.5 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg transition"
              title="Refresh balance"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="bg-[#121721] border-b border-slate-800 px-6 flex gap-6 text-sm">
        <button
          onClick={() => setActiveTab('trade')}
          className={`py-3 font-semibold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'trade' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          <TrendingUp className="w-4 h-4" /> Trade / Search Token
        </button>
        <button
          onClick={() => setActiveTab('positions')}
          className={`py-3 font-semibold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'positions' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          <PieChart className="w-4 h-4" /> Open Positions ({overview?.positions.length || 0})
        </button>
        <button
          onClick={() => setActiveTab('performance')}
          className={`py-3 font-semibold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'performance' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          <Award className="w-4 h-4" /> Performance & Analytics
        </button>
        <button
          onClick={() => setActiveTab('botguide')}
          className={`py-3 font-semibold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'botguide' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          <Terminal className="w-4 h-4" /> Telegram Bot Setup Guide
        </button>
        <button
          onClick={() => setActiveTab('hosting')}
          className={`py-3 font-semibold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'hosting' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          <ShieldCheck className="w-4 h-4" /> 24/7 Hosting &amp; Keep-Online
        </button>
        <button
          onClick={() => setActiveTab('github')}
          className={`py-3 font-semibold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'github' ? 'border-purple-500 text-purple-400' : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          <GitBranch className="w-4 h-4" /> Push to GitHub
        </button>
      </div>

      {/* Notice Message */}
      {notice && (
        <div className="bg-blue-950/80 border-b border-blue-800/80 px-6 py-2.5 text-sm text-blue-200 flex items-center justify-between">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-xs text-slate-400 hover:text-white">
            Dismiss
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {activeTab === 'trade' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Search & Token Input */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 shadow-xl">
                <h2 className="text-base font-bold text-white mb-2 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-blue-400" />
                  Look Up Token Contract Address
                </h2>
                <p className="text-xs text-slate-400 mb-4">
                  Paste any token contract address or DEX Screener URL across all chains (Solana, Ronin, Base, Ethereum, BSC, Arbitrum, Polygon, etc.):
                </p>

                <div className="flex flex-col sm:flex-row gap-3">
                  <select
                    value={selectedChain}
                    onChange={(e: any) => setSelectedChain(e.target.value)}
                    className="bg-[#1A2230] border border-slate-700 rounded-xl px-3 py-2.5 text-sm font-medium text-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="solana">Solana</option>
                    <option value="ronin">Ronin (Robin)</option>
                    <option value="base">Base</option>
                    <option value="ethereum">Ethereum</option>
                    <option value="bsc">BNB Chain</option>
                    <option value="arbitrum">Arbitrum</option>
                    <option value="polygon">Polygon</option>
                    <option value="avalanche">Avalanche</option>
                    <option value="sui">Sui</option>
                    <option value="ton">TON</option>
                    <option value="optimism">Optimism</option>
                    <option value="blast">Blast</option>
                    <option value="pulsechain">PulseChain</option>
                  </select>

                  <input
                    type="text"
                    value={searchAddr}
                    onChange={(e) => setSearchAddr(e.target.value)}
                    placeholder="e.g. DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
                    className="flex-1 bg-[#1A2230] border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
                  />

                  <button
                    onClick={() => handleLookup()}
                    disabled={loading || !searchAddr.trim()}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold px-6 py-2.5 rounded-xl text-sm transition flex items-center justify-center gap-2 shadow-lg shadow-blue-600/20"
                  >
                    {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : 'Inspect Token'}
                  </button>
                </div>

                {/* Preset Chips */}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500">Quick Test Samples:</span>
                  {sampleTokens.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => {
                        setSearchAddr(t.addr);
                        setSelectedChain(t.chain);
                        handleLookup(t.addr, t.chain);
                      }}
                      className="bg-slate-800/80 hover:bg-slate-700 text-xs px-2.5 py-1 rounded-lg text-slate-300 font-medium transition"
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quote Inspection Box */}
              {quote && (
                <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="bg-blue-500/20 text-blue-400 font-bold px-2 py-0.5 rounded text-xs">
                          {quote.token.chain.toUpperCase()}
                        </span>
                        <span className="text-xs text-slate-400">DEX: {quote.token.dexId.toUpperCase()}</span>
                      </div>
                      <h3 className="text-2xl font-black text-white tracking-tight mt-1">
                        {quote.token.name} <span className="text-slate-400 text-lg">({quote.token.symbol})</span>
                      </h3>
                      <p className="text-xs font-mono text-slate-500 mt-0.5">{quote.token.address}</p>
                    </div>

                    <div className="text-right">
                      <div className="text-xs text-slate-400 font-medium">USD Price</div>
                      <div className="text-3xl font-extrabold text-white tracking-tight">
                        ${parseFloat(quote.priceUsd) < 0.01 ? parseFloat(quote.priceUsd).toPrecision(6) : parseFloat(quote.priceUsd).toFixed(4)}
                      </div>
                    </div>
                  </div>

                  {/* Market Stats Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="bg-[#1A2230] p-3 rounded-xl border border-slate-800">
                      <div className="text-[11px] text-slate-400 uppercase font-semibold">Market Cap</div>
                      <div className="text-sm font-bold text-white mt-1">
                        {quote.marketCapUsd ? `$${parseFloat(quote.marketCapUsd).toLocaleString()}` : 'Unavailable'}
                      </div>
                    </div>
                    <div className="bg-[#1A2230] p-3 rounded-xl border border-slate-800">
                      <div className="text-[11px] text-slate-400 uppercase font-semibold">FDV</div>
                      <div className="text-sm font-bold text-white mt-1">
                        {quote.fdvUsd ? `$${parseFloat(quote.fdvUsd).toLocaleString()}` : 'Unavailable'}
                      </div>
                    </div>
                    <div className="bg-[#1A2230] p-3 rounded-xl border border-slate-800">
                      <div className="text-[11px] text-slate-400 uppercase font-semibold">Liquidity</div>
                      <div className="text-sm font-bold text-white mt-1">
                        {quote.liquidityUsd ? `$${parseFloat(quote.liquidityUsd).toLocaleString()}` : 'Unavailable'}
                      </div>
                    </div>
                    <div className="bg-[#1A2230] p-3 rounded-xl border border-slate-800">
                      <div className="text-[11px] text-slate-400 uppercase font-semibold">24h Volume</div>
                      <div className="text-sm font-bold text-white mt-1">
                        {quote.volume24hUsd ? `$${parseFloat(quote.volume24hUsd).toLocaleString()}` : 'Unavailable'}
                      </div>
                    </div>
                  </div>

                  {/* Price Changes */}
                  <div className="flex flex-wrap items-center gap-4 text-xs font-semibold">
                    <span className="text-slate-400">Price Changes:</span>
                    <span className={`px-2 py-1 rounded ${quote.priceChange.m5 >= 0 ? 'text-emerald-400 bg-emerald-950/40' : 'text-rose-400 bg-rose-950/40'}`}>
                      5m: {quote.priceChange.m5 != null ? `${quote.priceChange.m5}%` : 'N/A'}
                    </span>
                    <span className={`px-2 py-1 rounded ${quote.priceChange.h1 >= 0 ? 'text-emerald-400 bg-emerald-950/40' : 'text-rose-400 bg-rose-950/40'}`}>
                      1h: {quote.priceChange.h1 != null ? `${quote.priceChange.h1}%` : 'N/A'}
                    </span>
                    <span className={`px-2 py-1 rounded ${quote.priceChange.h6 >= 0 ? 'text-emerald-400 bg-emerald-950/40' : 'text-rose-400 bg-rose-950/40'}`}>
                      6h: {quote.priceChange.h6 != null ? `${quote.priceChange.h6}%` : 'N/A'}
                    </span>
                    <span className={`px-2 py-1 rounded ${quote.priceChange.h24 >= 0 ? 'text-emerald-400 bg-emerald-950/40' : 'text-rose-400 bg-rose-950/40'}`}>
                      24h: {quote.priceChange.h24 != null ? `${quote.priceChange.h24}%` : 'N/A'}
                    </span>
                  </div>

                  {/* Buy Presets */}
                  <div className="bg-[#1A2230] p-4 rounded-xl border border-slate-800 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="text-xs font-bold text-white">Simulated Paper Buy</div>
                      <div className="text-[11px] text-slate-400">Test real market execution with zero financial risk</div>
                    </div>

                    <div className="flex items-center gap-2">
                      {['25', '50', '100'].map((amt) => (
                        <button
                          key={amt}
                          onClick={() => handlePrepareBuy(amt)}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-4 py-2 rounded-lg transition"
                        >
                          Buy ${amt}
                        </button>
                      ))}
                      <a
                        href={quote.token.url}
                        target="_blank"
                        rel="noreferrer"
                        className="bg-slate-700 hover:bg-slate-600 text-white text-xs px-3 py-2 rounded-lg transition flex items-center gap-1"
                      >
                        DEX Screener <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right Column: Order Confirmation / Intent Box */}
            <div className="space-y-6">
              {previewData ? (
                <div className="bg-[#151B26] border border-blue-500/50 rounded-2xl p-6 shadow-2xl space-y-4">
                  <div className="flex items-center gap-2 text-blue-400 font-bold text-sm">
                    <ShieldCheck className="w-5 h-5" />
                    Confirm Simulated Buy Order
                  </div>

                  <div className="space-y-2 text-xs border-y border-slate-800 py-3">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Total Spend:</span>
                      <span className="font-bold text-white">${parseFloat(previewData.preview.spendAmountUsd).toFixed(2)} USD</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Simulated Fill Price:</span>
                      <span className="font-mono text-white">${parseFloat(previewData.preview.executedPriceUsd).toFixed(6)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Est. Received:</span>
                      <span className="font-bold text-emerald-400">
                        {parseFloat(previewData.preview.estimatedQuantity).toLocaleString()} {previewData.quote.token.symbol}
                      </span>
                    </div>
                    {previewData.preview.simulatedCosts && (
                      <div className="flex justify-between text-amber-400">
                        <span>Simulated Slippage & Fee:</span>
                        <span>{previewData.preview.slippagePercent}% / ${previewData.preview.feeUsd}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={handleConfirmBuy}
                      disabled={loading}
                      className="flex-1 bg-emerald-600 hover:bg-emerald-500 font-bold py-2.5 rounded-xl text-sm transition"
                    >
                      {loading ? 'Confirming...' : 'Execute Buy'}
                    </button>
                    <button
                      onClick={() => setPreviewData(null)}
                      className="px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium py-2.5 rounded-xl text-sm transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 text-center space-y-3">
                  <div className="w-12 h-12 rounded-full bg-blue-500/10 text-blue-400 flex items-center justify-center mx-auto">
                    <Activity className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-white">Manual Paper Practice</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Paste a contract address on the left to inspect real-time orderbook pricing and execute instant fills.
                  </p>
                </div>
              )}

              {/* Quick Settings & Reset */}
              <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 space-y-4">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <Settings className="w-4 h-4 text-slate-400" /> Practice Account Controls
                </h4>
                <div className="text-xs text-slate-400">
                  Practising with starting budget: <b>$1,000.00 virtual USD</b>. You can reset your practice bankroll at any time.
                </div>
                <button
                  onClick={handleResetSession}
                  className="w-full border border-rose-500/40 hover:bg-rose-500/10 text-rose-400 font-bold py-2 rounded-xl text-xs transition"
                >
                  Reset Practice Account ($1,000)
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Positions View */}
        {activeTab === 'positions' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white">Your Open Practice Positions</h2>
                <p className="text-xs text-slate-400">Real-time marked valuation against live DEX Screener price feeds</p>
              </div>
              <button
                onClick={fetchOverview}
                className="bg-slate-800 hover:bg-slate-700 text-xs px-3 py-2 rounded-xl font-medium transition flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh Valuations
              </button>
            </div>

            {overview?.positions && overview.positions.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {overview.positions.map((pos) => {
                  const entryPrice = parseFloat(pos.averageEntryPrice);
                  const costBasis = parseFloat(pos.remainingCostBasis);
                  const qty = parseFloat(pos.remainingQuantity);

                  return (
                    <div key={pos.positionId} className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="bg-blue-500/20 text-blue-400 font-bold px-2 py-0.5 rounded text-[10px]">
                            {pos.chain.toUpperCase()}
                          </span>
                          <h3 className="text-lg font-bold text-white mt-1">
                            {pos.symbol} <span className="text-xs text-slate-400 font-normal">{pos.tokenName}</span>
                          </h3>
                        </div>
                        <span className="bg-emerald-500/10 text-emerald-400 font-bold text-xs px-2.5 py-1 rounded-full border border-emerald-500/20">
                          OPEN
                        </span>
                      </div>

                      <div className="space-y-1.5 text-xs border-y border-slate-800/80 py-3">
                        <div className="flex justify-between">
                          <span className="text-slate-400">Holdings:</span>
                          <span className="font-mono text-white">{qty.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Cost Basis:</span>
                          <span className="text-white">${costBasis.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Avg Entry:</span>
                          <span className="font-mono text-white">${entryPrice.toFixed(6)}</span>
                        </div>
                        {parseFloat(pos.totalRealisedPnl) !== 0 && (
                          <div className="flex justify-between">
                            <span className="text-slate-400">Realised P&L (Partial):</span>
                            <span className={parseFloat(pos.totalRealisedPnl) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                              ${parseFloat(pos.totalRealisedPnl).toFixed(2)}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Action Buttons */}
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold text-slate-400">Paper Sell:</div>
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            onClick={() => handlePrepareSell(pos.positionId, '0.25')}
                            className="bg-slate-800 hover:bg-slate-700 text-white font-bold py-1.5 rounded-lg text-xs transition"
                          >
                            Sell 25%
                          </button>
                          <button
                            onClick={() => handlePrepareSell(pos.positionId, '0.50')}
                            className="bg-slate-800 hover:bg-slate-700 text-white font-bold py-1.5 rounded-lg text-xs transition"
                          >
                            Sell 50%
                          </button>
                          <button
                            onClick={() => handlePrepareSell(pos.positionId, '1.00')}
                            className="bg-rose-600/80 hover:bg-rose-500 text-white font-bold py-1.5 rounded-lg text-xs transition"
                          >
                            Sell 100%
                          </button>
                        </div>
                      </div>

                      {/* Card Preview Button */}
                      <button
                        onClick={async () => {
                          // Trigger telegram or view PNG card
                          const dummySnapshot = {
                            cardId: `card_${pos.positionId}`,
                            telegramId: 999999,
                            sessionId: pos.sessionId,
                            positionId: pos.positionId,
                            tokenName: pos.tokenName,
                            tokenSymbol: pos.symbol,
                            chain: pos.chain,
                            cardScope: 'open',
                            pnlUsd: '25.00',
                            pnlPercent: '25.00',
                            entryPriceUsd: pos.averageEntryPrice,
                            currentOrExitPriceUsd: pos.averageEntryPrice,
                            investedCostBasisUsd: pos.remainingCostBasis,
                            snapshotTimestamp: Date.now(),
                            theme: 'pepe',
                          };
                          setCardUrl(`/api/cards/${dummySnapshot.cardId}.png`);
                        }}
                        className="w-full bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 font-bold py-2 rounded-xl text-xs transition flex items-center justify-center gap-1.5"
                      >
                        <ImageIcon className="w-3.5 h-3.5" /> Generate 1200x675 P&L Card
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-12 text-center max-w-lg mx-auto space-y-4">
                <div className="w-16 h-16 bg-slate-800/80 rounded-full flex items-center justify-center mx-auto text-slate-500">
                  <PieChart className="w-8 h-8" />
                </div>
                <h3 className="text-base font-bold text-white">No Open Positions</h3>
                <p className="text-xs text-slate-400">
                  You currently have no open simulated holdings. Use the <b>Trade / Search Token</b> tab to buy memecoins with your virtual $1,000 balance!
                </p>
                <button
                  onClick={() => setActiveTab('trade')}
                  className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-6 py-2.5 rounded-xl text-xs transition shadow-lg shadow-blue-600/20"
                >
                  Find Token to Buy
                </button>
              </div>
            )}

            {/* Sell Confirmation Modal */}
            {sellPreviewData && (
              <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-[#151B26] border border-slate-700 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4">
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <TrendingDown className="w-5 h-5 text-rose-400" />
                    Confirm Paper Sell Order
                  </h3>

                  <div className="space-y-2 text-xs border-y border-slate-800 py-3">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Token:</span>
                      <span className="font-bold text-white">{sellPreviewData.preview.symbol}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Selling Quantity:</span>
                      <span className="font-mono text-white">
                        {parseFloat(sellPreviewData.preview.quantityToSell).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Simulated Net Proceeds:</span>
                      <span className="font-bold text-white">${parseFloat(sellPreviewData.preview.netProceedsUsd).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Estimated Realised P&L:</span>
                      <span
                        className={`font-bold ${
                          parseFloat(sellPreviewData.preview.estimatedRealisedPnlUsd) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        ${parseFloat(sellPreviewData.preview.estimatedRealisedPnlUsd).toFixed(2)} ({sellPreviewData.preview.estimatedReturnPercent}%)
                      </span>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={handleConfirmSell}
                      disabled={loading}
                      className="flex-1 bg-rose-600 hover:bg-rose-500 font-bold py-2.5 rounded-xl text-sm transition"
                    >
                      {loading ? 'Selling...' : 'Confirm Sell'}
                    </button>
                    <button
                      onClick={() => setSellPreviewData(null)}
                      className="px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium py-2.5 rounded-xl text-sm transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Performance Tab */}
        {activeTab === 'performance' && (
          <div className="space-y-6">
            <h2 className="text-xl font-bold text-white">Performance & Practice Analytics</h2>

            {overview?.stats ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                <div className="bg-[#151B26] p-6 rounded-2xl border border-slate-800 shadow-xl">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Account Equity</div>
                  <div className="text-3xl font-black text-white mt-2">
                    ${parseFloat(overview.stats.totalAccountEquityUsd).toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">Cash: ${parseFloat(overview.stats.cashBalance).toFixed(2)}</div>
                </div>

                <div className="bg-[#151B26] p-6 rounded-2xl border border-slate-800 shadow-xl">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Realised P&L</div>
                  <div
                    className={`text-3xl font-black mt-2 ${
                      parseFloat(overview.stats.totalRealisedPnlUsd) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    ${parseFloat(overview.stats.totalRealisedPnlUsd).toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">From closed positions</div>
                </div>

                <div className="bg-[#151B26] p-6 rounded-2xl border border-slate-800 shadow-xl">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Win Rate</div>
                  <div className="text-3xl font-black text-blue-400 mt-2">
                    {parseFloat(overview.stats.winRatePercent).toFixed(1)}%
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {overview.stats.winningTradesCount} Won / {overview.stats.completedPositionsCount} Completed
                  </div>
                </div>

                <div className="bg-[#151B26] p-6 rounded-2xl border border-slate-800 shadow-xl">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Unrealised</div>
                  <div
                    className={`text-3xl font-black mt-2 ${
                      parseFloat(overview.stats.totalUnrealisedPnlUsd) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    ${parseFloat(overview.stats.totalUnrealisedPnlUsd).toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">Marked to market</div>
                </div>
              </div>
            ) : (
              <div className="text-slate-400 text-sm">Loading statistics...</div>
            )}
          </div>
        )}

        {/* Telegram Bot Setup Guide & Connected Status */}
        {activeTab === 'botguide' && (
          <div className="max-w-3xl mx-auto space-y-6">
            {status?.botInfo ? (
              <div className="bg-gradient-to-r from-emerald-950/80 to-[#151B26] border border-emerald-500/50 rounded-2xl p-6 shadow-xl space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`w-2.5 h-2.5 rounded-full ${
                          status?.pollingStatus?.conflictDetected
                            ? 'bg-blue-400 animate-pulse'
                            : status?.pollingStatus?.isPaused
                            ? 'bg-amber-400'
                            : 'bg-emerald-400 animate-pulse'
                        }`}
                      />
                      <span
                        className={`text-xs font-semibold uppercase tracking-wider ${
                          status?.pollingStatus?.conflictDetected
                            ? 'text-blue-400'
                            : status?.pollingStatus?.isPaused
                            ? 'text-amber-400'
                            : 'text-emerald-400'
                        }`}
                      >
                        {status?.pollingStatus?.conflictDetected
                          ? 'Live Cloud Instance Active (Railway/Render)'
                          : status?.pollingStatus?.isPaused
                          ? 'Local Polling Paused'
                          : 'Telegram Bot Connected & Polling'}
                      </span>
                    </div>
                    <h2 className="text-xl font-bold text-white">
                      @{status.botInfo.username}
                    </h2>
                    <p className="text-xs text-slate-300 mt-1">
                      {status?.pollingStatus?.conflictDetected
                        ? 'Your bot is running continuously in the cloud on Railway/Render. Local dev polling is standing by so Telegram delivers messages uninterrupted to your live server.'
                        : 'Your bot is online, listening for updates, and using free public DEX Screener market data. Zero paid APIs needed.'}
                    </p>
                  </div>

                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <button
                      onClick={handleTogglePolling}
                      className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2.5 rounded-xl transition font-medium border border-slate-700/80"
                      title="Pause or resume local polling to avoid conflicts with your 24/7 cloud instance"
                    >
                      {status?.pollingStatus?.isPaused ? '▶️ Resume Local Polling' : '⏸️ Pause Local Polling'}
                    </button>

                    <a
                      href={`https://t.me/${status.botInfo.username}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold px-5 py-2.5 rounded-xl shadow-lg transition text-sm whitespace-nowrap"
                    >
                      Open @{status.botInfo.username} in Telegram
                    </a>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-emerald-800/30 text-xs">
                  <div className="bg-[#0E1217]/60 p-2.5 rounded-lg border border-slate-800">
                    <div className="font-mono text-emerald-300 font-bold">/start</div>
                    <div className="text-slate-400 text-[11px]">Get $1,000 balance</div>
                  </div>
                  <div className="bg-[#0E1217]/60 p-2.5 rounded-lg border border-slate-800">
                    <div className="font-mono text-emerald-300 font-bold">/buy</div>
                    <div className="text-slate-400 text-[11px]">Look up & buy token</div>
                  </div>
                  <div className="bg-[#0E1217]/60 p-2.5 rounded-lg border border-slate-800">
                    <div className="font-mono text-emerald-300 font-bold">/positions</div>
                    <div className="text-slate-400 text-[11px]">Sell / take profit</div>
                  </div>
                  <div className="bg-[#0E1217]/60 p-2.5 rounded-lg border border-slate-800">
                    <div className="font-mono text-emerald-300 font-bold">/performance</div>
                    <div className="text-slate-400 text-[11px]">Win rate & P&L card</div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Terminal className="w-5 h-5 text-blue-400" />
                Telegram Bot Status & Details
              </h2>

              <p className="text-xs text-slate-300 leading-relaxed">
                DJN Paper Trader requires <b>zero external paid API keys</b> and <b>no private blockchain credentials</b>. All live pricing uses the free public DEX Screener API across all chains (Solana, Ronin, Base, Ethereum, BSC, Arbitrum, and beyond).
              </p>

              <div className="space-y-4 text-xs">
                <div className="bg-[#1A2230] p-4 rounded-xl border border-slate-700/80 space-y-2">
                  <div className="font-bold text-blue-400">Step 1: Get Your Bot Token from @BotFather</div>
                  <p className="text-slate-300">
                    Open Telegram, search for <b>@BotFather</b>, and send <code>/newbot</code>. Choose a display name and username ending in <code>_bot</code>. BotFather will provide your HTTP API Token.
                  </p>
                </div>

                <div className="bg-[#1A2230] p-4 rounded-xl border border-slate-700/80 space-y-2">
                  <div className="font-bold text-blue-400">Step 2: Add TELEGRAM_BOT_TOKEN to Environment</div>
                  <p className="text-slate-300">
                    In your project Settings / environment variables, configure:
                  </p>
                  <pre className="bg-[#0E1217] p-2 rounded text-emerald-400 font-mono text-[11px]">
TELEGRAM_BOT_TOKEN={status?.botConfigured ? '••••••••••••••••••••••••••••' : 'your_token_from_botfather'}
                  </pre>
                  <p className="text-slate-400 text-[11px]">
                    That is literally all! The bot will automatically start polling Telegram and respond to your messages immediately. No webhooks, no paid APIs, and no blockchain wallets required.
                  </p>
                </div>

                <div className="bg-[#1A2230] p-4 rounded-xl border border-slate-700/80 space-y-2">
                  <div className="font-bold text-blue-400">Step 3: Open Your Bot &amp; Start Trading!</div>
                  <p className="text-slate-300">
                    Open your bot in Telegram and send <code>/start</code>. You will be credited with <b>$1,000.00 virtual USD</b> to practice trading tokens across Solana, Ronin, Base, Ethereum, BSC, Arbitrum, and any DEX Screener chain!
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 24/7 Hosting & Keep-Online Guide */}
        {activeTab === 'hosting' && (
          <div className="max-w-4xl mx-auto space-y-6">
            {/* Why Does It Pause Alert */}
            <div className="bg-amber-950/40 border border-amber-500/40 rounded-2xl p-6 text-slate-200 space-y-3">
              <div className="flex items-center gap-3 text-amber-400 font-bold text-base">
                <AlertTriangle className="w-5 h-5 flex-shrink-0" />
                Why does the app pause when you leave this place?
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">
                Right now, the bot is running inside Google AI Studio&apos;s <b>interactive development sandbox</b>. To conserve cloud computing resources, Google puts this sandbox to sleep whenever you close the browser tab or stay idle.
              </p>
              <p className="text-sm text-slate-300 leading-relaxed">
                Because long-polling requires an active process to pull updates from Telegram, when the sandbox sleeps, the bot cannot receive messages. <b>Your balance and open positions are safely saved on disk</b>, but to keep the bot replying <b>24/7 independently even with your computer and browser completely turned off</b>, deploy it to a continuous host using one of the options below.
              </p>
            </div>

            {/* Quick Status Card */}
            <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Current Connection Mode</div>
                <div className="text-lg font-bold text-white flex items-center gap-2 mt-1">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      status?.pollingStatus?.conflictDetected
                        ? 'bg-blue-400 animate-pulse'
                        : status?.pollingStatus?.isPaused
                        ? 'bg-amber-400'
                        : 'bg-emerald-400 animate-pulse'
                    }`}
                  />
                  {status?.pollingStatus?.conflictDetected
                    ? '24/7 Cloud Bot Live (Railway/Render)'
                    : status?.pollingStatus?.isPaused
                    ? 'Local Polling Paused'
                    : 'Direct Telegram Long-Polling (Auto-Reconnect)'}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  {status?.pollingStatus?.conflictDetected
                    ? 'Your production deployment is online and actively handling user trades on Telegram.'
                    : `Database: ${status?.storage?.type || 'Persistent Local File Store'}`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleTogglePolling}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs px-3.5 py-2.5 rounded-xl border border-slate-700 transition"
                >
                  {status?.pollingStatus?.isPaused ? '▶️ Resume Local Polling' : '⏸️ Pause Local Polling'}
                </button>
                {status?.botInfo && (
                  <a
                    href={`https://t.me/${status.botInfo.username}`}
                    target="_blank"
                    rel="noreferrer"
                    className="bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs px-4 py-2.5 rounded-xl transition flex items-center gap-2"
                  >
                    <Send className="w-4 h-4" /> Open @{status.botInfo.username} on Telegram
                  </a>
                )}
              </div>
            </div>

            {/* Hosting Options Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Option 1: Railway / Render (Easiest Cloud 24/7) */}
              <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 space-y-4">
                <div className="flex items-center gap-2.5 text-base font-bold text-white">
                  <span className="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs font-black">
                    1
                  </span>
                  Free/Low-Cost Cloud Hosting (Render / Railway)
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Best option for beginners. These platforms provide continuous servers that run 24/7 without needing your laptop or browser open.
                </p>
                <div className="space-y-2 text-xs text-slate-300">
                  <div className="p-3 bg-[#1A2230] rounded-xl border border-slate-700/60 space-y-1">
                    <span className="font-semibold text-emerald-400">Step 1: Export or push to GitHub</span>
                    <p className="text-slate-400 text-[11px]">Download your app files or push them to a private GitHub repository.</p>
                  </div>
                  <div className="p-3 bg-[#1A2230] rounded-xl border border-slate-700/60 space-y-1">
                    <span className="font-semibold text-emerald-400">Step 2: Create Web Service</span>
                    <p className="text-slate-400 text-[11px]">Go to <b>Railway.app</b> or <b>Render.com</b> &gt; New Web Service &gt; Select your repo.</p>
                  </div>
                  <div className="p-3 bg-[#1A2230] rounded-xl border border-slate-700/60 space-y-1">
                    <span className="font-semibold text-emerald-400">Step 3: Set Environment Variable</span>
                    <pre className="bg-[#0E1217] p-2 rounded text-emerald-400 font-mono text-[11px] mt-1 overflow-x-auto">
TELEGRAM_BOT_TOKEN={status?.botConfigured ? '8863471433:AAE6MtZF8cilY-3i3TpgOr2npM1FXIKiZXw' : 'your_bot_token'}
                    </pre>
                  </div>
                  <div className="p-3 bg-[#1A2230] rounded-xl border border-slate-700/60 space-y-1">
                    <span className="font-semibold text-emerald-400">Step 4: Build &amp; Start Command</span>
                    <div className="font-mono text-[11px] text-blue-300">Build: npm run build</div>
                    <div className="font-mono text-[11px] text-blue-300">Start: npm start</div>
                  </div>
                </div>
              </div>

              {/* Option 2: Docker Container (Any VPS or Server) */}
              <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 space-y-4">
                <div className="flex items-center gap-2.5 text-base font-bold text-white">
                  <span className="w-7 h-7 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center text-xs font-black">
                    2
                  </span>
                  Docker &amp; Docker Compose (Self-Host VPS / PC)
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  A multi-stage <code>Dockerfile</code> and <code>docker-compose.yml</code> are included in the repository. Runs on any Linux server, VPS (DigitalOcean, Hetzner, AWS), or background home server.
                </p>
                <div className="space-y-3 text-xs">
                  <div>
                    <span className="text-slate-400 font-medium">One-command startup:</span>
                    <pre className="bg-[#0E1217] p-3 rounded-xl text-blue-400 font-mono text-[11px] mt-1 overflow-x-auto border border-slate-800">
docker compose up -d --build
                    </pre>
                  </div>
                  <div className="text-slate-400 text-[11px]">
                    The <code>restart: always</code> policy ensures your bot reboots automatically after system updates or server reboots, maintaining 100% uptime.
                  </div>

                  <div>
                    <span className="text-slate-400 font-medium">Or run with PM2 on any Node.js server:</span>
                    <pre className="bg-[#0E1217] p-3 rounded-xl text-emerald-400 font-mono text-[11px] mt-1 overflow-x-auto border border-slate-800">
npm run build
npx pm2 start dist/server.js --name "djn-bot"
                    </pre>
                  </div>
                </div>
              </div>
            </div>

            {/* Option 3: Keep AI Studio Alive with Uptime Monitors */}
            <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-2.5 text-base font-bold text-white">
                <span className="w-7 h-7 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center text-xs font-black">
                  3
                </span>
                Alternative: Uptime Pingers (Free Warm-Up)
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                If you prefer not to deploy elsewhere right now, you can register a free uptime monitor (such as <b>cron-job.org</b>, <b>UptimeRobot</b>, or <b>BetterStack</b>) to ping your shared health endpoint every 2 minutes:
              </p>
              <div className="bg-[#0E1217] p-3 rounded-xl border border-slate-800 text-xs font-mono text-purple-300 flex items-center justify-between gap-2 overflow-x-auto">
                <span>{status?.publicBaseUrl ? `${status.publicBaseUrl}/api/health` : 'https://<your-app-url>/api/health'}</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Note: External pingers can keep web servers warm, but dedicated cloud hosting (Option 1 or 2) provides the most reliable 24/7 uptime for instant Telegram message delivery.
              </p>
            </div>
          </div>
        )}

        {/* Push to GitHub & Export Center */}
        {activeTab === 'github' && (
          <div className="max-w-4xl mx-auto space-y-6">
            {/* Git Status Card */}
            <div className="bg-gradient-to-r from-purple-950/60 to-[#151B26] border border-purple-500/40 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-purple-400 animate-pulse" />
                    <span className="text-xs font-semibold text-purple-400 uppercase tracking-wider">
                      Local Git Repository Ready
                    </span>
                  </div>
                  <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <GitBranch className="w-5 h-5 text-purple-400" />
                    Branch: {gitInfo?.branch || 'main'}
                  </h2>
                  <p className="text-xs text-slate-300 mt-1">
                    {gitInfo?.latestCommit?.message
                      ? `Latest Commit: "${gitInfo.latestCommit.message}" (${gitInfo.latestCommit.hash})`
                      : 'All project code, tests, and configuration files are tracked in Git.'}
                  </p>
                </div>

                <a
                  href="/api/git/download"
                  download="djn-paper-trader.zip"
                  className="inline-flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 text-white font-semibold px-5 py-3 rounded-xl shadow-lg transition text-xs whitespace-nowrap"
                >
                  <Download className="w-4 h-4" />
                  Download Code (.zip)
                </a>
              </div>

              {/* Security Shield Note */}
              <div className="flex items-start gap-3 bg-[#0E1217]/70 p-3.5 rounded-xl border border-purple-800/30 text-xs text-slate-300">
                <ShieldCheck className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="text-emerald-400 font-semibold">Security Guard Active: </span>
                  Your <code>.env</code> file containing your secret Telegram Bot Token is excluded by <code>.gitignore</code>. Your personal bot token will never be uploaded to GitHub.
                </div>
              </div>
            </div>

            {/* Push Directly to GitHub Form */}
            <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
              <div className="flex items-center gap-2.5 text-base font-bold text-white">
                <UploadCloud className="w-5 h-5 text-blue-400" />
                Push Directly to GitHub
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Enter your GitHub repository URL and a Personal Access Token below to push this codebase directly to your repository in one step.
              </p>

              <form onSubmit={handleGitPush} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    GitHub Repository URL <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={gitRepoUrl}
                    onChange={(e) => setGitRepoUrl(e.target.value)}
                    placeholder="https://github.com/your-username/djn-paper-trader.git"
                    className="w-full bg-[#0E1217] border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 font-mono"
                    required
                  />
                  <div className="text-[11px] text-slate-500 mt-1">
                    Create an empty repository on GitHub first at <a href="https://github.com/new" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">github.com/new</a> (do not initialize with README or license).
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center justify-between">
                    <span>GitHub Personal Access Token (PAT)</span>
                    <a
                      href="https://github.com/settings/tokens/new?scopes=repo"
                      target="_blank"
                      rel="noreferrer"
                      className="text-purple-400 hover:underline text-[11px] flex items-center gap-1 font-normal"
                    >
                      <ExternalLink className="w-3 h-3" /> Generate token on GitHub (scope: repo)
                    </a>
                  </label>
                  <input
                    type="password"
                    value={gitToken}
                    onChange={(e) => setGitToken(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    className="w-full bg-[#0E1217] border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 font-mono"
                  />
                  <div className="text-[11px] text-slate-500 mt-1">
                    GitHub requires a Personal Access Token instead of your password for HTTPS git pushes.
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                      Target Branch
                    </label>
                    <input
                      type="text"
                      value={gitBranchName}
                      onChange={(e) => setGitBranchName(e.target.value)}
                      placeholder="main"
                      className="w-full bg-[#0E1217] border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-purple-500"
                    />
                  </div>

                  <div className="flex items-center gap-2 pt-6">
                    <input
                      type="checkbox"
                      id="forcePush"
                      checked={gitForce}
                      onChange={(e) => setGitForce(e.target.checked)}
                      className="w-4 h-4 rounded border-slate-700 text-purple-600 focus:ring-purple-500 bg-[#0E1217]"
                    />
                    <label htmlFor="forcePush" className="text-xs text-slate-300 cursor-pointer">
                      Force push (overwrite remote history if exists)
                    </label>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={gitPushing || !gitRepoUrl.trim()}
                  className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-semibold py-3 rounded-xl shadow-lg transition text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {gitPushing ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Pushing to GitHub...
                    </>
                  ) : (
                    <>
                      <UploadCloud className="w-4 h-4" />
                      Push to GitHub Now
                    </>
                  )}
                </button>
              </form>

              {/* Push Result Banner */}
              {gitPushResult && (
                <div
                  className={`p-4 rounded-xl border text-xs space-y-2 ${
                    gitPushResult.success
                      ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-200'
                      : 'bg-rose-950/60 border-rose-500/50 text-rose-200'
                  }`}
                >
                  <div className="font-bold flex items-center gap-2">
                    {gitPushResult.success ? (
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-rose-400" />
                    )}
                    {gitPushResult.message}
                  </div>
                  {gitPushResult.output && (
                    <pre className="bg-[#0E1217] p-2.5 rounded font-mono text-[11px] overflow-x-auto text-slate-300">
                      {gitPushResult.output}
                    </pre>
                  )}
                </div>
              )}
            </div>

            {/* Manual CLI Push Commands */}
            <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5 text-base font-bold text-white">
                  <Terminal className="w-5 h-5 text-emerald-400" />
                  Or Push Using Your Computer's Terminal
                </div>
                <button
                  onClick={() =>
                    copyToClipboard(
                      `git remote add origin ${gitRepoUrl || 'https://github.com/YOUR_USERNAME/YOUR_REPO.git'}\ngit branch -M main\ngit push -u origin main`,
                      'cli-commands'
                    )
                  }
                  className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition"
                >
                  {copiedKey === 'cli-commands' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" /> Copy Commands
                    </>
                  )}
                </button>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed">
                If you downloaded the code or have git configured locally on your laptop, run these standard git commands:
              </p>

              <pre className="bg-[#0E1217] p-4 rounded-xl font-mono text-xs text-emerald-400 border border-slate-800 overflow-x-auto space-y-1">
                <div>git remote add origin {gitRepoUrl || 'https://github.com/YOUR_USERNAME/YOUR_REPO.git'}</div>
                <div>git branch -M main</div>
                <div>git push -u origin main</div>
              </pre>
            </div>

            {/* Next Steps: 24/7 Cloud Host */}
            <div className="bg-[#151B26] border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
              <div className="text-sm font-bold text-white flex items-center gap-2">
                <Activity className="w-4 h-4 text-blue-400" />
                What to do after pushing to GitHub:
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Once your code is on GitHub, you can link it to <b>Railway</b> or <b>Render</b> with one click. They will automatically build and keep your Telegram bot running 24/7 in the cloud so you can close this window and trade anytime from Telegram!
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
