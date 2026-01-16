import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { storage } from "./storage";
import type { CommentDisplay, InsertComment } from "@shared/schema";

interface WebSocketMessage {
  type: "new_comment" | "delete_comment" | "get_comments" | "comments_list" | "error";
  payload?: any;
}

let wss: WebSocketServer | null = null;
const clients: Set<WebSocket> = new Set();

export function initializeWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: "/ws" });
  
  wss.on("connection", (ws: WebSocket) => {
    console.log("[WS] New client connected");
    clients.add(ws);
    
    // Send recent comments to new client
    sendRecentComments(ws);
    
    ws.on("message", async (data: Buffer) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        await handleMessage(ws, message);
      } catch (error) {
        console.error("[WS] Error parsing message:", error);
        ws.send(JSON.stringify({ type: "error", payload: "Invalid message format" }));
      }
    });
    
    ws.on("close", () => {
      console.log("[WS] Client disconnected");
      clients.delete(ws);
    });
    
    ws.on("error", (error) => {
      console.error("[WS] WebSocket error:", error);
      clients.delete(ws);
    });
  });
  
  console.log("[WS] WebSocket server initialized on /ws");
  return wss;
}

async function sendRecentComments(ws: WebSocket) {
  try {
    const comments = await storage.getComments(50);
    const displayComments: CommentDisplay[] = comments.map(c => ({
      id: c.id,
      author: c.author,
      content: c.content,
      symbol: c.symbol,
      createdAt: c.createdAt?.toISOString() || new Date().toISOString(),
    }));
    
    ws.send(JSON.stringify({
      type: "comments_list",
      payload: displayComments,
    }));
  } catch (error) {
    console.error("[WS] Error sending recent comments:", error);
  }
}

async function handleMessage(ws: WebSocket, message: WebSocketMessage) {
  switch (message.type) {
    case "new_comment":
      await handleNewComment(message.payload);
      break;
    case "delete_comment":
      await handleDeleteComment(message.payload);
      break;
    case "get_comments":
      await sendRecentComments(ws);
      break;
    default:
      ws.send(JSON.stringify({ type: "error", payload: "Unknown message type" }));
  }
}

// Sanitize text to remove HTML/XSS vectors - encode ALL dangerous characters
function sanitizeText(input: string): string {
  return input
    .replace(/&/g, "&amp;")  // Must be first to avoid double-encoding
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;")
    .replace(/`/g, "&#96;")
    .replace(/=/g, "&#x3D;")
    .replace(/\(/g, "&#40;")
    .replace(/\)/g, "&#41;")
    .trim();
}

async function handleNewComment(payload: { author: string; content: string; symbol?: string }) {
  if (!payload.author || !payload.content) {
    return;
  }
  
  // Sanitize input - escape HTML entities to prevent XSS
  const author = sanitizeText(payload.author).slice(0, 50);
  const content = sanitizeText(payload.content).slice(0, 500);
  const symbol = payload.symbol ? sanitizeText(payload.symbol).slice(0, 20) : null;
  
  if (!author || !content) {
    return;
  }
  
  try {
    const comment = await storage.addComment({
      author,
      content,
      symbol,
    });
    
    const displayComment: CommentDisplay = {
      id: comment.id,
      author: comment.author,
      content: comment.content,
      symbol: comment.symbol,
      createdAt: comment.createdAt?.toISOString() || new Date().toISOString(),
    };
    
    // Broadcast to all connected clients
    broadcastMessage({
      type: "new_comment",
      payload: displayComment,
    });
    
    console.log(`[WS] New comment from ${author}: ${content.slice(0, 30)}...`);
  } catch (error) {
    console.error("[WS] Error adding comment:", error);
  }
}

async function handleDeleteComment(payload: { id: number }) {
  if (!payload.id) {
    return;
  }
  
  try {
    await storage.deleteComment(payload.id);
    
    // Broadcast deletion to all clients
    broadcastMessage({
      type: "delete_comment",
      payload: { id: payload.id },
    });
    
    console.log(`[WS] Comment ${payload.id} deleted`);
  } catch (error) {
    console.error("[WS] Error deleting comment:", error);
  }
}

function broadcastMessage(message: WebSocketMessage) {
  const messageStr = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

export function getConnectedClientsCount(): number {
  return clients.size;
}
