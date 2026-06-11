import { Switch, Route, Redirect } from 'wouter';
import { LandingPage } from './pages/LandingPage';
import { Dashboard } from './pages/Dashboard';
import { AdminPanel } from './pages/AdminPanel';
import { LoginPage } from './pages/LoginPage';
import { ReferralPage } from './pages/ReferralPage';
import { useAuthStore } from './store/useAuthStore';

function App() {
  const { isAuthenticated, user } = useAuthStore();

  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/register" component={LoginPage} />
      <Route path="/ref/:code" component={ReferralPage} />
      <Route path="/dashboard">
        {isAuthenticated ? <Dashboard /> : <Redirect to="/login" />}
      </Route>
      <Route path="/admin">
        {isAuthenticated && ['admin', 'super_admin'].includes(user?.role || '') ? <AdminPanel /> : <Redirect to="/login" />}
      </Route>
      <Route>404 - Page Not Found</Route>
    </Switch>
  );
}

export default App;
