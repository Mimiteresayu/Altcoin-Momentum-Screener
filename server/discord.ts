import axios from "axios";
import type { Signal } from "@shared/schema";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: {
    text: string;
  };
  timestamp?: string;
}

interface DiscordMessage {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds?: DiscordEmbed[];
}

const SIGNAL_COLORS = {
  HOT: 0xff4444,      // Red
  MAJOR: 0xffa500,    // Orange
  ACTIVE: 0x00ff88,   // Green
  PRE: 0x4488ff,      // Blue
  LONG: 0x00ff88,     // Green for LONG
  SHORT: 0xff4444,    // Red for SHORT
};

const SIGNAL_EMOJIS = {
  HOT: "🔥",
  MAJOR: "👑",
  ACTIVE: "⚡",
  PRE: "⏳",
  LONG: "📈",
  SHORT: "📉",
};

function formatPrice(price: number): string {
  if (price < 0.0001) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  if (price < 10) return price.toFixed(4);
  return price.toFixed(2);
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export async function sendSignalNotification(signal: Signal): Promise<boolean> {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("[DISCORD] No webhook URL configured, skipping notification");
    return false;
  }

  const sideEmoji = SIGNAL_EMOJIS[signal.side];
  const typeEmoji = SIGNAL_EMOJIS[signal.signalType || "PRE"];
  const color = signal.side === "SHORT" ? SIGNAL_COLORS.SHORT : SIGNAL_COLORS[signal.signalType || "PRE"];

  const embed: DiscordEmbed = {
    title: `${typeEmoji} ${signal.signalType || "PRE"} Signal: ${signal.symbol}`,
    description: `${sideEmoji} **${signal.side}** position detected`,
    color,
    fields: [
      {
        name: "💰 Entry Price",
        value: `$${formatPrice(signal.currentPrice)}`,
        inline: true,
      },
      {
        name: "📊 24h Change",
        value: formatPercent(signal.priceChange24h),
        inline: true,
      },
      {
        name: "📈 Volume Spike",
        value: `${signal.volumeSpikeRatio.toFixed(1)}x`,
        inline: true,
      },
      {
        name: "🎯 RSI",
        value: signal.rsi.toFixed(0),
        inline: true,
      },
      {
        name: "⚡ Signal Strength",
        value: `${signal.signalStrength}/5`,
        inline: true,
      },
      {
        name: "📉 Risk/Reward",
        value: `1:${signal.riskReward.toFixed(1)}`,
        inline: true,
      },
      {
        name: "🛑 Stop Loss",
        value: `$${formatPrice(signal.slPrice)} (${formatPercent(-signal.slDistancePct)})`,
        inline: true,
      },
      {
        name: "🎯 Take Profits",
        value: signal.tpLevels.slice(0, 3).map(tp => 
          `TP${tp.label.replace("TP", "")}: $${formatPrice(tp.price)} (+${tp.pct.toFixed(1)}%)`
        ).join("\n"),
        inline: true,
      },
    ],
    footer: {
      text: "Signal Scanner • Pre-Spike Detection",
    },
    timestamp: new Date().toISOString(),
  };

  // Add OI field if available
  if (signal.oiChange24h !== null && signal.oiChange24h !== undefined) {
    embed.fields.splice(4, 0, {
      name: "📊 OI Change",
      value: formatPercent(signal.oiChange24h),
      inline: true,
    });
  }

  const message: DiscordMessage = {
    username: "Signal Scanner",
    embeds: [embed],
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, message, {
      headers: { "Content-Type": "application/json" },
      timeout: 5000,
    });
    console.log(`[DISCORD] Sent notification for ${signal.symbol} (${signal.signalType})`);
    return true;
  } catch (error: any) {
    console.error(`[DISCORD] Failed to send notification:`, error.message);
    return false;
  }
}

export async function sendBatchSignalNotification(signals: Signal[]): Promise<number> {
  if (!DISCORD_WEBHOOK_URL) {
    return 0;
  }

  let successCount = 0;
  
  // Only send notifications for high-priority signals (HOT, MAJOR, ACTIVE)
  const prioritySignals = signals.filter(s => 
    s.signalType === "HOT" || s.signalType === "MAJOR" || s.signalType === "ACTIVE"
  );

  for (const signal of prioritySignals) {
    const success = await sendSignalNotification(signal);
    if (success) successCount++;
    
    // Rate limit: wait 1 second between messages to avoid Discord rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return successCount;
}

// Track which signals have been notified to avoid duplicate notifications
const notifiedSignals = new Map<string, Date>();
const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown per symbol

export async function notifyNewSignals(signals: Signal[]): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) {
    return;
  }

  const now = new Date();
  
  for (const signal of signals) {
    // Only notify for HOT or new MAJOR/ACTIVE signals
    if (signal.signalType !== "HOT" && signal.signalType !== "MAJOR" && signal.signalType !== "ACTIVE") {
      continue;
    }

    const lastNotified = notifiedSignals.get(signal.symbol);
    if (lastNotified && (now.getTime() - lastNotified.getTime()) < NOTIFICATION_COOLDOWN_MS) {
      continue; // Skip if recently notified
    }

    const success = await sendSignalNotification(signal);
    if (success) {
      notifiedSignals.set(signal.symbol, now);
    }

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Cleanup old entries from the tracking map
  const entries = Array.from(notifiedSignals.entries());
  for (const [symbol, timestamp] of entries) {
    if (now.getTime() - timestamp.getTime() > NOTIFICATION_COOLDOWN_MS * 2) {
      notifiedSignals.delete(symbol);
    }
  }
}

export function isDiscordConfigured(): boolean {
  return !!DISCORD_WEBHOOK_URL;
}
