import { Switch, Route, Link, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "@/pages/Dashboard";
import Backtest from "@/pages/Backtest";
import TradingCockpit from "@/pages/TradingCockpit";
import NotFound from "@/pages/not-found";
import PasswordGate from "@/components/auth/PasswordGate";
import { Button } from "@/components/ui/button";
import { Activity, LineChart, Crosshair } from "lucide-react";
import { clsx } from "clsx";

function NavLink({ href, children, icon }: { href: string; children: React.ReactNode; icon: React.ReactNode }) {
  const [location] = useLocation();
  const isActive = location === href;

  return (
    <Link href={href}>
      <Button 
        variant="ghost" 
        size="sm" 
        className={clsx(
          "gap-1.5",
          isActive && "bg-primary/10 text-primary"
        )}
      >
        {icon}
        {children}
      </Button>
    </Link>
  );
}

function Navigation() {
  return (
    <nav className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-card/90 backdrop-blur-md border border-white/10 rounded-full px-2 py-1.5 flex gap-1 shadow-xl shadow-black/20">
      <NavLink href="/" icon={<Activity className="w-4 h-4" />}>
        Signals
      </NavLink>
      <NavLink href="/backtest" icon={<LineChart className="w-4 h-4" />}>
        Backtest
      </NavLink>
      <NavLink href="/cockpit" icon={<Crosshair className="w-4 h-4" />}>
        Cockpit
      </NavLink>
    </nav>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/backtest" component={Backtest} />
      <Route path="/cockpit" component={TradingCockpit} />
      <Route path="/:rest*" component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PasswordGate>
          <Router />
          <Navigation />
        </PasswordGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
