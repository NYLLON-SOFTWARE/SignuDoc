import { SignupShell } from "@/components/auth/signup-shell";
import { buildBranding } from "@/lib/branding";
import { getSettings } from "@/lib/settings";
import { describeSignupPolicy } from "@/lib/signup-policy";

export default async function SignupPage() {
  const settings = await getSettings();

  return (
    <SignupShell
      signupAvailable={buildBranding(settings).signupAvailable}
      // Says who can sign up before anyone fills the form in. Nothing to
      // say when anyone can.
      signupRule={
        settings.signupMode === "open" ? null : describeSignupPolicy(settings)
      }
    />
  );
}
