import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MessageCircle, Send, User, Clock, Users, Wifi, WifiOff } from "lucide-react";
import { clsx } from "clsx";
import type { CommentDisplay } from "@shared/schema";

interface CommentSectionProps {
  className?: string;
}

export function CommentSection({ className }: CommentSectionProps) {
  const [comments, setComments] = useState<CommentDisplay[]>([]);
  const [author, setAuthor] = useState(() => localStorage.getItem("commentAuthor") || "");
  const [content, setContent] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [connectedUsers, setConnectedUsers] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const commentsEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    commentsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    // Connect to WebSocket
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const connect = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      ws.onopen = () => {
        console.log("[WS] Connected");
        setIsConnected(true);
      };
      
      ws.onclose = () => {
        console.log("[WS] Disconnected");
        setIsConnected(false);
        // Reconnect after 3 seconds
        setTimeout(connect, 3000);
      };
      
      ws.onerror = (error) => {
        console.error("[WS] Error:", error);
        setIsConnected(false);
      };
      
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleMessage(message);
        } catch (error) {
          console.error("[WS] Error parsing message:", error);
        }
      };
    };
    
    connect();
    
    // Fetch connected users count periodically
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/ws/status");
        const data = await res.json();
        setConnectedUsers(data.connectedClients || 0);
      } catch {
        // Ignore errors
      }
    };
    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 10000);
    
    return () => {
      clearInterval(statusInterval);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const handleMessage = (message: { type: string; payload: any }) => {
    switch (message.type) {
      case "comments_list":
        setComments(message.payload);
        setTimeout(scrollToBottom, 100);
        break;
      case "new_comment":
        setComments(prev => [...prev, message.payload]);
        setTimeout(scrollToBottom, 100);
        break;
      case "delete_comment":
        setComments(prev => prev.filter(c => c.id !== message.payload.id));
        break;
    }
  };

  const sendComment = () => {
    if (!author.trim() || !content.trim() || !wsRef.current) return;
    
    // Save author name
    localStorage.setItem("commentAuthor", author.trim());
    
    wsRef.current.send(JSON.stringify({
      type: "new_comment",
      payload: {
        author: author.trim(),
        content: content.trim(),
      },
    }));
    
    setContent("");
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendComment();
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <Card className={clsx("bg-card/50 backdrop-blur-sm border-white/5", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageCircle className="w-4 h-4 text-primary" />
            Live Discussion
          </CardTitle>
          <div className="flex items-center gap-2">
            {isConnected ? (
              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px]">
                <Wifi className="w-3 h-3 mr-1" />
                Live
              </Badge>
            ) : (
              <Badge className="bg-rose-500/20 text-rose-400 border-rose-500/30 text-[10px]">
                <WifiOff className="w-3 h-3 mr-1" />
                Offline
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px]">
              <Users className="w-3 h-3 mr-1" />
              {connectedUsers} online
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div 
          className="h-48 overflow-y-auto space-y-2 pr-2 custom-scrollbar"
          data-testid="comments-list"
        >
          {comments.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              No comments yet. Be the first to share your thoughts!
            </div>
          ) : (
            comments.map((comment) => (
              <div 
                key={comment.id} 
                className="bg-muted/30 rounded-lg p-2 text-sm"
                data-testid={`comment-${comment.id}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <User className="w-3 h-3 text-muted-foreground" />
                  <span className="font-medium text-xs">{comment.author}</span>
                  <span className="text-muted-foreground text-[10px] flex items-center gap-0.5">
                    <Clock className="w-2.5 h-2.5" />
                    {formatTime(comment.createdAt)}
                  </span>
                  {comment.symbol && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0">
                      {comment.symbol}
                    </Badge>
                  )}
                </div>
                <p className="text-foreground/90 text-xs pl-5">{comment.content}</p>
              </div>
            ))
          )}
          <div ref={commentsEndRef} />
        </div>
        
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Your name"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            className="w-24 px-2 py-1.5 bg-muted/30 border border-white/5 rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/20"
            data-testid="input-author"
            maxLength={50}
          />
          <input
            type="text"
            placeholder="Share your thoughts..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyPress={handleKeyPress}
            className="flex-1 px-3 py-1.5 bg-muted/30 border border-white/5 rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/20"
            data-testid="input-comment"
            maxLength={500}
          />
          <Button 
            size="sm" 
            onClick={sendComment}
            disabled={!isConnected || !author.trim() || !content.trim()}
            data-testid="button-send-comment"
          >
            <Send className="w-3 h-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
