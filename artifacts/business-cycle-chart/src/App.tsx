import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import ChartPage from "@/pages/ChartPage";
import FractalPage from "@/pages/FractalPage";
import ChannelPage from "@/pages/ChannelPage";
import HousingPage from "@/pages/HousingPage";
import RecessionPage from "@/pages/RecessionPage";
import CyclicalPage from "@/pages/CyclicalPage";
import GliPage from "@/pages/GliPage";
import BtcQuantilePage from "@/pages/BtcQuantilePage";
import RateShockPage from "@/pages/RateShockPage";
import LoginPage from "@/pages/LoginPage";
import SignupPage from "@/pages/SignupPage";
import AccountPage from "@/pages/AccountPage";
import AdminPage from "@/pages/AdminPage";
import { AuthProvider, useAuth } from "@/lib/auth";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 0,
      gcTime: 0,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  const { user, loading, requireSubscription, subscribed } = useAuth();
  if (loading) return <div className="min-h-[100dvh]" style={{ background: "hsl(230 14% 8%)" }} />;
  if (!user) {
    return (
      <Switch>
        <Route path="/signup" component={SignupPage} />
        <Route component={LoginPage} />
      </Switch>
    );
  }
  if (requireSubscription && user.role !== "admin" && !subscribed) {
    return <AccountPage paywalled />;
  }
  return (
    <Switch>
      <Route path="/account">{() => <AccountPage />}</Route>
      {user.role === "admin" && <Route path="/admin" component={AdminPage} />}
      <Route path="/" component={ChartPage} />
      <Route path="/fractal" component={FractalPage} />
      <Route path="/channel" component={ChannelPage} />
      <Route path="/housing" component={HousingPage} />
      <Route path="/recession" component={RecessionPage} />
      <Route path="/rate-shock" component={RateShockPage} />
      <Route path="/cyclical" component={CyclicalPage} />
      <Route path="/gli" component={GliPage} />
      <Route path="/btc-quantile" component={BtcQuantilePage} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
