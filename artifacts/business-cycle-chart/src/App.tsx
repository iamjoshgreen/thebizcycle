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
  return (
    <Switch>
      <Route path="/" component={ChartPage} />
      <Route path="/fractal" component={FractalPage} />
      <Route path="/channel" component={ChannelPage} />
      <Route path="/housing" component={HousingPage} />
      <Route path="/recession" component={RecessionPage} />
      <Route path="/cyclical" component={CyclicalPage} />
      <Route path="/gli" component={GliPage} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
