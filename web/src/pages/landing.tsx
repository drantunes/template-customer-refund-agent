import { Link } from "react-router-dom";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowRight } from "lucide-react";

export function Landing() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Welcome to the demo</CardTitle>
          <CardDescription>
            A quick look at an AI-assisted support workflow, built with Mastra.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>
            This baseline uses deterministic local mocks. Connect a real support
            provider only after its adapter and security controls have been
            implemented and verified.
          </p>
          <p>
            First, you'll submit a message to customer support. Then, you'll see
            the admin dashboard, where you can see how the AI handles each case
            and when it needs your help.
          </p>
        </CardContent>
        <CardFooter>
          <Link to="/portal" className={buttonVariants()}>
            Let's go
            <ArrowRight data-icon="inline-end" />
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
