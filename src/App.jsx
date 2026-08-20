import { AnimatePresence, motion } from "framer-motion";
import { Routes, Route, useLocation } from "react-router-dom";
import NavBar from "./components/layout/NavBar.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import DescribeJob from "./pages/DescribeJob.jsx";
import Recommendations from "./pages/Recommendations.jsx";
import EquipmentDetails from "./pages/EquipmentDetails.jsx";
import AddEquipment from "./pages/AddEquipment.jsx";
import Booking from "./pages/Booking.jsx";
import MyBookings from "./pages/MyBookings.jsx";
import Profile from "./pages/Profile.jsx";
import Auth from "./pages/Auth.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import { useAuth } from "./context/AuthContext.jsx";

function PageTransition({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 26, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, y: -16, filter: "blur(4px)" }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

function RouteProgress({ path }) {
  return (
    <motion.div
      key={path}
      className="fixed left-0 top-0 z-[999] h-[3px] bg-gradient-to-r from-wheat via-sky to-wheat"
      initial={{ width: "0%", opacity: 1 }}
      animate={{ width: "100%", opacity: [1, 1, 0] }}
      transition={{ duration: 0.7, ease: "easeInOut" }}
    />
  );
}

export default function App() {
  const location = useLocation();
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink text-white/60 text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full max-w-[100vw] overflow-x-hidden bg-ink">
      <RouteProgress path={location.pathname} />
      {isAuthenticated && <NavBar />}
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/auth" element={<Auth />} />
          <Route path="/" element={<ProtectedRoute><PageTransition><Dashboard /></PageTransition></ProtectedRoute>} />
          <Route path="/describe-job" element={<ProtectedRoute><PageTransition><DescribeJob /></PageTransition></ProtectedRoute>} />
          <Route path="/recommendations" element={<ProtectedRoute><PageTransition><Recommendations /></PageTransition></ProtectedRoute>} />
          <Route path="/equipment/:id" element={<ProtectedRoute><PageTransition><EquipmentDetails /></PageTransition></ProtectedRoute>} />
          <Route path="/equipment/new" element={<ProtectedRoute><PageTransition><AddEquipment /></PageTransition></ProtectedRoute>} />
          <Route path="/equipment/:id/edit" element={<ProtectedRoute><PageTransition><AddEquipment /></PageTransition></ProtectedRoute>} />
          <Route path="/booking/:id" element={<ProtectedRoute><PageTransition><Booking /></PageTransition></ProtectedRoute>} />
          <Route path="/bookings" element={<ProtectedRoute><PageTransition><MyBookings /></PageTransition></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><PageTransition><Profile /></PageTransition></ProtectedRoute>} />
        </Routes>
      </AnimatePresence>
      {isAuthenticated && <div className="h-16 md:hidden" />}
    </div>
  );
}
