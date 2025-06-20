import { ProjectsView } from "@/components/projects";
import { SidebarDemo } from "@/components/ui/code.demo";

export default function ProjectsPage() {
  return (
    <SidebarDemo>
      <div className="projects-page bg-background">
        <ProjectsView />
      </div>
    </SidebarDemo>
  );
} 