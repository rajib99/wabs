import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { reviewPhotoAction } from "@/app/admin/actions";

/** Photos are shared without prior approval; an admin can still remove one that should not be shown. */
export function PhotoReview({ id }: { id: string }) {
  return (
    <ActionForm action={reviewPhotoAction}>
      <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value="reject" />
      <Button variant="destructive" className="w-full">ছবি সরিয়ে ফেলুন</Button>
    </ActionForm>
  );
}
