import { PaidAccess } from "@/components/PaidAccess";
import { lazy, Suspense } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AnalyticsConsent } from "@/components/AnalyticsConsent";

// Eager imports: landing page components always needed on first paint
import Home from "@/pages/Home";
import NotFound from "@/pages/not-found";

// Lazy imports: code-split by route for smaller initial bundle
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Auth = lazy(() => import("@/pages/Auth"));
const Members = lazy(() => import("@/pages/Members"));
const Settings = lazy(() => import("@/pages/Settings"));
const Notifications = lazy(() => import("@/pages/Notifications"));
const Reports = lazy(() => import("@/pages/Reports"));
const Payment = lazy(() => import("@/pages/Payment"));
const ForgotPassword = lazy(() => import("@/pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const Privacy = lazy(() => import("@/pages/Privacy"));
const Terms = lazy(() => import("@/pages/Terms"));
const AdminDashboard = lazy(() => import("@/pages/AdminDashboard"));
const AdminHealth = lazy(() => import("@/pages/AdminHealth"));

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
    </div>
  );
}

function Router() {
  // Key the per-route boundary by location so navigating away from a broken
  // page resets the boundary and the new route renders cleanly. This keeps a
  // single broken page from taking down the shell/nav around it.
  const [location] = useLocation();

  return (
    <ErrorBoundary scopeLabel="route" resetKey={location}>
      <Suspense fallback={<PageLoader />}>
        <Switch>
          <Route path="/" component={Home}/>
          <Route path="/dashboard/:id"><PaidAccess><Dashboard /></PaidAccess></Route>
          <Route path="/dashboard"><PaidAccess><Dashboard /></PaidAccess></Route>
          <Route path="/auth" component={Auth}/>
          <Route path="/members"><PaidAccess><Members /></PaidAccess></Route>
          <Route path="/settings" component={Settings}/>
          <Route path="/notifications"><PaidAccess><Notifications /></PaidAccess></Route>
          <Route path="/reports"><PaidAccess><Reports /></PaidAccess></Route>
          <Route path="/payment" component={Payment}/>
          <Route path="/forgot-password" component={ForgotPassword}/>
          <Route path="/reset-password" component={ResetPassword}/>
          <Route path="/privacy" component={Privacy}/>
          <Route path="/terms" component={Terms}/>
          <Route path="/admin/health" component={AdminHealth}/>
          <Route path="/admin" component={AdminDashboard}/>
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </ErrorBoundary>
  );
}

function App() {
  return (
    // Outer boundary is the last-resort safety net: if the shell itself (or a
    // provider) throws, this still renders a fallback instead of a blank page.
    <ErrorBoundary scopeLabel="app">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Router />
          <AnalyticsConsent />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
