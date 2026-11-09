import { Button } from "@/components/ui/button";
import { reviewPhotoAction } from "@/app/admin/actions";

/** One form per decision, so the choice is an explicit field rather than the clicked button's value. */
export function PhotoReview({ id }: { id: string }) {
  return (
    <div className="flex gap-2">
      <form action={reviewPhotoAction} className="flex-1">
        <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value="approve" />
        <Button className="w-full">অনুমোদন</Button>
      </form>
      <form action={reviewPhotoAction} className="flex-1">
        <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value="reject" />
        <Button variant="destructive" className="w-full">বাতিল</Button>
      </form>
    </div>
  );
}
