import DriverShell from "../components/DriverShell";
import ProfileForm from "../components/ProfileForm";
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
      <div className="super-body">
        <ProfileForm
          user={user}
          onUser={onUser}
          note="Имя, почта, телефон и пароль. Роль и борт здесь не меняются."
        />
      </div>
    </DriverShell>
  );
}
