import DriverShell from "../components/DriverShell";
import DriverProfile from "../components/DriverProfile";
import type { User } from "../types";

export default function DriverProfilePage({
  user,
  onUser,
}: {
  user: User;
  onUser: (user: User) => void;
}) {
  return (
    <DriverShell>
      <DriverProfile user={user} onUser={onUser} />
    </DriverShell>
  );
}
