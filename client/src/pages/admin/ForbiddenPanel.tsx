import { Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Compact inline panel shown when an admin sub-section returns 403.
 *
 * Without this, sub-page fetchers swallowed the 403 (`if (res.status === 403)
 * return;`) and fell through to their empty-data UI — making a permission error
 * look identical to "there is no data". This surfaces the access problem
 * explicitly and consistently across every admin section.
 */
export function ForbiddenPanel({
  message = "You don't have access to this section.",
}: {
  message?: string;
}) {
  return (
    <Card className="border border-slate-200 shadow-sm">
      <CardContent className="p-10 text-center">
        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
          <Lock className="w-6 h-6 text-slate-400" />
        </div>
        <p className="text-slate-500">{message}</p>
      </CardContent>
    </Card>
  );
}
