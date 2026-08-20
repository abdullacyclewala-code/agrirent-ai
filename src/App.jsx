import { AnimatePresence, motion } from "framer-motion";
import { Routes, Route, useLocation } from "react-router-dom";
import NavBar from "./components/layout/NavBar.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import DescribeJob from "./pages/DescribeJob.jsx";
import Recommendations from "./pages/Recommendations.jsx";
import EquipmentDetails from "./pages/EquipmentDetails.jsx";
import Booking from "./pages/Booking.jsx";
import Profile from "./pages/Profile.jsx";

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
  return (
    <div className="min-h-screen w-full max-w-[100vw] overflow-x-hidden bg-ink">
      <RouteProgress path={location.pathname} />
      <NavBar />
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<PageTransition><Dashboard /></PageTransition>} />
          <Route path="/describe-job" element={<PageTransition><DescribeJob /></PageTransition>} />
          <Route path="/recommendations" element={<PageTransition><Recommendations /></PageTransition>} />
          <Route path="/equipment/:id" element={<PageTransition><EquipmentDetails /></PageTransition>} />
          <Route path="/booking/:id" element={<PageTransition><Booking /></PageTransition>} />
          <Route path="/profile" element={<PageTransition><Profile /></PageTransition>} />
        </Routes>
      </AnimatePresence>
      <div className="h-16 md:hidden" />
    </div>
  );
}
